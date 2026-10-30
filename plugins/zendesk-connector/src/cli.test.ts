import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HELP_FLAGS, KNOWN_FLAGS, isHelpRequested, unknownFlags, usage } from "./cli.js";

const here = dirname(fileURLToPath(import.meta.url));

test("recognises the flags that ask for the usage", () => {
  assert.equal(isHelpRequested(["--help"]), true);
  assert.equal(isHelpRequested(["-h"]), true);
  assert.equal(isHelpRequested(["--doctor"]), false);
  assert.equal(isHelpRequested([]), false);
});

test("names the flags it does not understand", () => {
  assert.deepEqual(
    unknownFlags(["--doctor", "--tools", "--healthcheck", "--logout"]),
    [],
  );
  assert.deepEqual(unknownFlags(["--help", "-h"]), []);
  assert.deepEqual(unknownFlags(["--nonsense"]), ["--nonsense"]);
  assert.deepEqual(unknownFlags(["--doctor", "-x"]), ["-x"]);
});

test("the usage text names every flag and what it does", () => {
  const text = usage();
  // The list is driven by the flags the connector accepts, so a flag that is
  // added and not documented is a failure here rather than a surprise. The
  // flags are compared as whole words, so a flag that is the beginning of
  // another one is not counted as documented.
  const words = new Set(text.replace(/[.,]/g, " ").split(/\s+/));
  for (const flag of [...KNOWN_FLAGS, ...HELP_FLAGS]) {
    assert.ok(words.has(flag), `the usage should name ${flag}`);
  }
  // The text says what each mode does, not only that it exists.
  assert.match(text, /Check the configuration/);
  assert.match(text, /the tools the agent will receive/);
  assert.match(text, /Revoke the OAuth token/);
  assert.match(text, /never contact Zendesk/);
});

test("accepts the stdio flag without changing what the connector does", async () => {
  // The connector always speaks stdio, so the flag says nothing. It must not
  // be refused, and it must not change the mode that runs.
  assert.deepEqual(unknownFlags(["--stdio"]), []);

  const result = await runCli(["--stdio", "--doctor"], {
    ZENDESK_OAUTH_MODE: "client_credentials",
    ZENDESK_SUBDOMAIN: "example",
    ZENDESK_OAUTH_CLIENT_ID: "invented-client-id",
    ZENDESK_OAUTH_CLIENT_SECRET: "invented-client-secret",
  });

  // The doctor ran, so the flag was not a refusal and not a mode of its own.
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Zendesk connector doctor: all checks passed/);
});

test("--help wins over an unknown flag", async () => {
  // Asking for the usage is asking for the usage, whatever else is on the
  // command line.
  const result = await runCli(["--help", "--nonsense"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /zendesk-mcp --doctor/);
  assert.equal(result.stderr, "");
});

test("an unknown flag is refused before any mode runs", async () => {
  // A typo must not silently start the server or run a mode the operator
  // did not ask for.
  for (const mode of ["--doctor", "--tools", "--healthcheck", "--logout"]) {
    const result = await runCli([mode, "--nonsense"]);
    assert.equal(result.code, 2, `${mode} should not run`);
    assert.match(result.stderr, /Unknown option: --nonsense/);
    assert.equal(result.stdout, "");
  }
});

test("an argument that is not a flag is refused", async () => {
  const result = await runCli(["doctro"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unexpected argument: doctro/);
});

test("a bare -- is not a flag the connector refuses", async () => {
  const result = await runCli(["--", "--doctor"], {
    ZENDESK_OAUTH_MODE: "client_credentials",
    ZENDESK_SUBDOMAIN: "example",
    ZENDESK_OAUTH_CLIENT_ID: "invented-client-id",
    ZENDESK_OAUTH_CLIENT_SECRET: "invented-client-secret",
  });

  // The end-of-options marker carries no meaning here, so the flag after it
  // is still a flag.
  assert.equal(result.code, 0);
  assert.ok(!result.stderr.includes("Unknown option"));
});

test("--help prints the usage and exits", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /zendesk-mcp --doctor/);
  assert.equal(result.stderr, "");
});

test("an unknown flag is refused instead of starting the server", async () => {
  const result = await runCli(["--nonsense"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown option: --nonsense/);
  // Nothing on stdout: the server never started, so it printed no start line.
  assert.equal(result.stdout, "");
});

test("--tools prints what the agent will receive", async () => {
  const result = await runCli(["--tools"], {
    ZENDESK_OAUTH_MODE: "client_credentials",
    ZENDESK_SUBDOMAIN: "example",
    ZENDESK_OAUTH_CLIENT_ID: "invented-client-id",
    ZENDESK_OAUTH_CLIENT_SECRET: "invented-client-secret",
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Base URL: https:\/\/example\.zendesk\.com/);
  assert.match(result.stdout, /OAuth mode: client_credentials/);
  assert.match(result.stdout, /Scope: /);
  // The operator can see what the agent will receive without starting it.
  assert.match(result.stdout, /Enabled tools \(12 of 12\): /);
});

/**
 * Runs the built connector with the given arguments.
 *
 * The child's stdin stays open, so a connector that falls through to the
 * server waits for it — which is the failure this suite exists to catch. The
 * timeout turns that wait into a failed test instead of a hung suite.
 */
function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(here, "index.js"), ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
      signal: AbortSignal.timeout(20_000),
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
      reject(
        new Error(
          `the connector did not exit for ${args.join(" ")}: ${error.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
