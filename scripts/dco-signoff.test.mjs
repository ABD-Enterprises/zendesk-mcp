// Self-tests for the DCO sign-off check in .github/workflows/dco.yml.
//
// Usage:
//   node --test scripts/dco-signoff.test.mjs
//
// The check is a jq filter that `gh api --jq` applies to the pull request's
// commits. The filter is read out of the workflow file, so these tests
// exercise the filter the workflow actually ships rather than a copy of it.
//
// The filter runs against a local mock server on an ephemeral loopback port
// that serves fixture commits. No network access, no credentials and no
// GitHub account are involved: the request goes to 127.0.0.1 and the mock
// server answers it. The GitHub CLI still wants a token before it makes any
// API call, so the child gets a placeholder that authenticates nothing.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const WORKFLOW_PATH = path.join(
  REPOSITORY_ROOT,
  ".github",
  "workflows",
  "dco.yml",
);

// The filter the workflow hands to `gh api --jq`. It is read from the
// workflow file, so a change to the shipped filter is what these tests
// check. The filter is one single-quoted shell argument on one line.
function readWorkflowFilter() {
  const workflow = fs.readFileSync(WORKFLOW_PATH, "utf8");
  const candidates = workflow
    .split("\n")
    .filter((candidate) => candidate.includes("--jq '"));
  assert.ok(candidates.length > 0, "the workflow must pass a --jq filter to gh api");
  // The sign-off filter is the one that looks for a sign-off line, so it is
  // picked out by what it checks rather than by where it sits in the file.
  const signOffLines = candidates.filter((candidate) =>
    candidate.includes("Signed-off-by"),
  );
  assert.equal(
    signOffLines.length,
    1,
    "the workflow must pass exactly one sign-off filter to gh api",
  );
  const line = signOffLines[0];
  const start = line.indexOf("--jq '") + "--jq '".length;
  const end = line.lastIndexOf("'");
  assert.ok(end > start, "the --jq filter must be single-quoted on one line");
  return line.slice(start, end);
}

const FILTER = readWorkflowFilter();

// One commit object in the shape the GitHub API returns them.
function commit(sha, message, parents = 1) {
  return {
    sha,
    parents: Array.from({ length: parents }, (_, index) => ({
      sha: `parent-${index}`,
    })),
    commit: { message },
  };
}

// The fixtures and the sha prefixes the filter is expected to report. A
// commit is reported when its message carries no sign-off line.
const REPORTED = [
  ["unsigned message", commit("1111111111111111111111111111111111111111", "subject\n\nbody\n")],
  [
    "unsigned message with Windows line endings",
    commit("2222222222222222222222222222222222222222", "subject\r\n\r\nbody\r\n"),
  ],
  [
    "sign-off mentioned mid-line",
    commit("3333333333333333333333333333333333333333", "subject Signed-off-by: Dev <dev@example.com>\n"),
  ],
  [
    "sign-off followed by trailing text",
    commit("4444444444444444444444444444444444444444", "Signed-off-by: Dev <dev@example.com> extra\n"),
  ],
  [
    "sign-off without a space before the email",
    commit("5555555555555555555555555555555555555555", "Signed-off-by: Dev<dev@example.com>\n"),
  ],
];

const NOT_REPORTED = [
  [
    "sign-off with Unix line endings",
    commit("6666666666666666666666666666666666666666", "subject\n\nSigned-off-by: Dev <dev@example.com>\n"),
  ],
  [
    "sign-off with Windows line endings",
    commit("7777777777777777777777777777777777777777", "subject\r\n\r\nSigned-off-by: Dev <dev@example.com>\r\n"),
  ],
  [
    "sign-off with Windows line endings and no trailing newline",
    commit("8888888888888888888888888888888888888888", "subject\r\n\r\nSigned-off-by: Dev <dev@example.com>"),
  ],
  [
    "merge commit without a sign-off",
    commit("9999999999999999999999999999999999999999", "subject\n\nbody\n", 2),
  ],
];

// The GitHub CLI refuses to make an API call when it has no token, and in a
// GitHub Actions workflow it says so outright. The token is not what these
// tests check - the filter is - so the child gets a fixed placeholder that
// authenticates nothing: the request goes to a loopback mock server that
// ignores the header, and a real token from the environment is never used.
//
// The enterprise token variables are cleared for the same reason. The CLI
// treats a host that is not github.com as an enterprise host and prefers the
// enterprise token over GH_TOKEN for it, so an inherited
// GH_ENTERPRISE_TOKEN would be sent to the loopback mock server - a live
// credential reaching a port the test opens.
const PLACEHOLDER_TOKEN = "dco-signoff-self-test-placeholder";

// Run the `gh api` invocation and collect its output. The call is
// asynchronous on purpose: the mock server runs in this process, so a
// synchronous child process would block the event loop that has to answer
// the request.
function runGhApi(url) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", ["api", "--paginate", url, "--jq", FILTER], {
      env: {
        ...process.env,
        GH_TOKEN: PLACEHOLDER_TOKEN,
        GITHUB_TOKEN: "",
        GH_ENTERPRISE_TOKEN: "",
        GITHUB_ENTERPRISE_TOKEN: "",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        reject(
          new Error(
            "the DCO sign-off self-test needs the GitHub CLI (gh) on the path: " +
              "the workflow runs its filter through `gh api --jq`",
          ),
        );
        return;
      }
      reject(error);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`gh api did not finish: ${stderr}`));
    }, 30_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

// Serve the fixtures over a loopback port and run the workflow's filter
// against them with the same engine the workflow uses.
async function runFilterOver(commits) {
  const body = JSON.stringify(commits);
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const { port } = server.address();
    return await runGhApi(`http://127.0.0.1:${port}/commits`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("the filter the workflow ships reports the commits without a sign-off", async () => {
  const commits = [...REPORTED, ...NOT_REPORTED].map(([, value]) => value);
  const result = await runFilterOver(commits);

  assert.equal(result.status, 0, `gh api failed: ${result.stderr}`);
  const reported = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
  const expected = REPORTED.map(([, value]) => value.sha.slice(0, 12)).sort();
  assert.deepEqual(reported, expected);
});

test("a signed commit with Windows line endings is not reported", async () => {
  const [, signedCrlf] = NOT_REPORTED[1];
  const result = await runFilterOver([signedCrlf]);

  assert.equal(result.status, 0, `gh api failed: ${result.stderr}`);
  assert.equal(result.stdout.trim(), "");
});

test("an unsigned commit with Windows line endings is still reported", async () => {
  const [, unsignedCrlf] = REPORTED[1];
  const result = await runFilterOver([unsignedCrlf]);

  assert.equal(result.status, 0, `gh api failed: ${result.stderr}`);
  assert.equal(result.stdout.trim(), unsignedCrlf.sha.slice(0, 12));
});

test("a sign-off must occupy a whole line", async () => {
  const [, midLine] = REPORTED[2];
  const [, trailingText] = REPORTED[3];
  const result = await runFilterOver([midLine, trailingText]);

  assert.equal(result.status, 0, `gh api failed: ${result.stderr}`);
  const reported = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean).sort();
  assert.deepEqual(reported, [midLine.sha.slice(0, 12), trailingText.sha.slice(0, 12)].sort());
});
