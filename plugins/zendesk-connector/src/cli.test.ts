import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isHelpRequested, unknownFlags, usage } from "./cli.js";

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

test("the usage text names every flag", () => {
  const text = usage();
  for (const flag of [
    "--doctor",
    "--tools",
    "--healthcheck",
    "--logout",
    "--help",
  ]) {
    assert.ok(text.includes(flag), `the usage should name ${flag}`);
  }
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

/**
 * Runs the built connector with the given arguments.
 *
 * The child's stdin stays open, so a connector that falls through to the
 * server waits for it — which is the failure this suite exists to catch. The
 * timeout turns that wait into a failed test instead of a hung suite.
 */
function runCli(
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(here, "index.js"), ...args], {
      stdio: ["pipe", "pipe", "pipe"],
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
