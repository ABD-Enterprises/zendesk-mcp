// Self-tests for scripts/changelog.py, the fleet changelog notes tool.
//
// Usage:
//   node --test scripts/changelog-tool.test.mjs
//
// Each case builds a throwaway Git repository, so no network access and no
// credentials are involved. The tests skip when python3 is not installed.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const TOOL = path.join(SCRIPT_DIRECTORY, "changelog.py");
const PYTHON_MISSING = spawnSync("python3", ["--version"]).error?.code === "ENOENT";
const OPTIONS = { skip: PYTHON_MISSING ? "python3 is unavailable" : false };

const CHANGELOG = [
  "# Changelog", "", "## Unreleased", "", "### Fixed", "- Existing fix.", "",
  "## 1.0.0", "", "- Released change.", "",
].join("\n");

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.error, undefined);
  return result;
}

function git(cwd, ...args) {
  const result = run("git", args, cwd);
  assert.equal(result.status, 0, result.stderr);
}

function repository(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-tool-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  write(dir, files);
  commit(dir);
  return dir;
}

function write(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

function commit(dir) {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "change");
}

function changelogTool(dir, ...args) {
  return run("python3", [TOOL, "--root", dir, ...args], dir);
}

test("the repository's own changelog notes pass the check", OPTIONS, () => {
  const result = run("python3", [TOOL, "check"], REPOSITORY_ROOT);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("assemble folds a note into Unreleased and the guard accepts the fold", OPTIONS, (t) => {
  const dir = repository(t, {
    "CHANGELOG.md": CHANGELOG,
    "changelog.d/fix.md": "- [Fixed] Folded fix.\n",
  });
  const base = run("git", ["rev-parse", "HEAD"], dir).stdout.trim();
  assert.equal(changelogTool(dir, "assemble").status, 0);
  assert.equal(
    fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8"),
    CHANGELOG.replace("- Existing fix.\n", "- Existing fix.\n- Folded fix.\n"),
  );
  assert.equal(fs.existsSync(path.join(dir, "changelog.d/fix.md")), false);
  commit(dir);
  const check = changelogTool(dir, "check", "--base", base);
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

test("the guard rejects a committed direct addition under Unreleased", OPTIONS, (t) => {
  const dir = repository(t, { "CHANGELOG.md": CHANGELOG });
  write(dir, {
    "CHANGELOG.md": CHANGELOG.replace("- Existing fix.\n", "- Existing fix.\n- Direct edit.\n"),
  });
  commit(dir);
  const check = changelogTool(dir, "check", "--base", "HEAD^1");
  assert.equal(check.status, 1);
  assert.match(check.stdout, /Direct edit\./u);
});
