// Self-tests for the action pin check in
// .github/scripts/check-action-pins.sh.
//
// Usage:
//   node --test scripts/action-pins.test.mjs
//
// The tests run the script as a subprocess against fixture workflow files
// written to a temporary directory. No network access and no GitHub account
// are involved.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const SCRIPT_PATH = path.join(
  REPOSITORY_ROOT,
  ".github",
  "scripts",
  "check-action-pins.sh",
);

// A full commit SHA: 40 lowercase hexadecimal characters.
const FULL_SHA = "0123456789abcdef0123456789abcdef01234567";
// The same SHA with three characters cut off.
const TRUNCATED_SHA = "0123456789abcdef0123456789abcdef0";

const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeWorkflowFiles(files) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "action-pins-"));
  temporaryDirectories.push(directory);
  const workflows = path.join(directory, "workflows");
  mkdirSync(workflows, { recursive: true });
  for (const [fileName, contents] of Object.entries(files)) {
    writeFileSync(path.join(workflows, fileName), contents, "utf8");
  }
  return workflows;
}

function writeWorkflow(contents, fileName = "ci.yml") {
  return writeWorkflowFiles({ [fileName]: contents });
}

function workflowWith(pin) {
  return [
    "name: CI",
    "on:",
    "  push:",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    `      - uses: ${pin}`,
    "",
  ].join("\n");
}

function runCheck(arguments_) {
  const result = spawnSync("bash", [SCRIPT_PATH, ...arguments_], {
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

test("accepts a full 40 character commit SHA", () => {
  const workflows = writeWorkflow(workflowWith(`example/checkout@${FULL_SHA}`));
  const result = runCheck([workflows]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^OK/m);
});

test("rejects a truncated commit SHA", () => {
  const workflows = writeWorkflow(
    workflowWith(`example/checkout@${TRUNCATED_SHA}`),
  );
  const result = runCheck([workflows]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ci\.yml/);
  assert.match(result.stderr, /example\/checkout@0123456789abcdef0123456789abcdef0/);
  assert.match(result.stderr, /has 33 characters/);
});

test("rejects a commit SHA that is too long", () => {
  const workflows = writeWorkflow(
    workflowWith(`example/checkout@${FULL_SHA}ab`),
  );
  const result = runCheck([workflows]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /has 42 characters/);
});

test("accepts a tag ref", () => {
  const workflows = writeWorkflow(workflowWith("example/checkout@v1.2.3"));
  const result = runCheck([workflows]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^OK/m);
});

test("skips a local action", () => {
  const workflows = writeWorkflow(workflowWith("./action.yml"));
  const result = runCheck([workflows]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^OK/m);
});

test("checks a workflow file with the .yaml suffix", () => {
  const workflows = writeWorkflow(
    workflowWith(`example/checkout@${TRUNCATED_SHA}`),
    "ci.yaml",
  );
  const result = runCheck([workflows]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ci\.yaml/);
  assert.match(result.stderr, /has 33 characters/);
});

test("accepts a valid pin in a workflow file with the .yaml suffix", () => {
  const workflows = writeWorkflow(
    workflowWith(`example/checkout@${FULL_SHA}`),
    "ci.yaml",
  );
  const result = runCheck([workflows]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^OK/m);
});

test("checks every workflow file in the directory", () => {
  // The .yml file holds a valid pin and stays untouched, the .yaml file
  // holds the offending one and is the only file reported.
  const workflows = writeWorkflowFiles({
    "ci.yml": workflowWith(`example/checkout@${FULL_SHA}`),
    "release.yaml": workflowWith(`example/setup@${TRUNCATED_SHA}`),
  });
  const result = runCheck([workflows]);
  assert.equal(result.status, 1);
  const reports = result.stderr
    .split("\n")
    .filter((line) => line.includes("invalid action pin"));
  assert.equal(reports.length, 1);
  assert.match(reports[0], /release\.yaml/);
  assert.match(reports[0], /has 33 characters/);
});

test("checks a double quoted pin", () => {
  const workflows = writeWorkflow(
    workflowWith(`"example/checkout@${TRUNCATED_SHA}"`),
  );
  const result = runCheck([workflows]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /example\/checkout@0123456789abcdef0123456789abcdef0/);
  assert.match(result.stderr, /has 33 characters/);
});

test("checks a single quoted pin", () => {
  const workflows = writeWorkflow(
    workflowWith(`'example/checkout@${TRUNCATED_SHA}'`),
  );
  const result = runCheck([workflows]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /example\/checkout@0123456789abcdef0123456789abcdef0/);
  assert.match(result.stderr, /has 33 characters/);
});

test("accepts a mixed case ref that is not hexadecimal", () => {
  // A ref that is not written in lowercase hexadecimal is a tag, so the
  // length rule does not apply to it and the ref is accepted as it is.
  const workflows = writeWorkflow(
    workflowWith("example/checkout@AbCdEf0123456789abcdef"),
  );
  const result = runCheck([workflows]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^OK/m);
});

test("rejects an empty ref", () => {
  const workflows = writeWorkflow(workflowWith("example/checkout@"));
  const result = runCheck([workflows]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /has 0 characters/);
});

test("reports every offending pin", () => {
  const workflows = writeWorkflow(
    [
      "jobs:",
      "  build:",
      "    steps:",
      `      - uses: example/checkout@${TRUNCATED_SHA}`,
      "      - uses: example/setup@abcdef",
      "",
    ].join("\n"),
  );
  const result = runCheck([workflows]);
  assert.equal(result.status, 1);
  const reports = result.stderr
    .split("\n")
    .filter((line) => line.includes("invalid action pin"));
  assert.equal(reports.length, 2);
});

// The body of a block scalar is text, not a key. The fixture line below is a
// pin that the script reports when it meets it outside a block scalar, so the
// block scalar tests below fail when the block scalar is not recognized any
// more.
const BLOCK_SCALAR_BODY = `        uses: example/checkout@${TRUNCATED_SHA}`;

for (const header of ["      - run: |", "      - run: >-"]) {
  test(`ignores a uses line inside a block scalar (${header.trim()})`, () => {
    const workflows = writeWorkflow(
      [
        "jobs:",
        "  build:",
        "    steps:",
        header,
        BLOCK_SCALAR_BODY,
        "",
      ].join("\n"),
    );
    const result = runCheck([workflows]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
  });
}

for (const header of ["      - run: | # a comment", "      - run: >- # a comment"]) {
  test(`ignores a uses line inside a block scalar with a trailing comment (${header.trim()})`, () => {
    const workflows = writeWorkflow(
      [
        "jobs:",
        "  build:",
        "    steps:",
        header,
        BLOCK_SCALAR_BODY,
        "",
      ].join("\n"),
    );
    const result = runCheck([workflows]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
  });
}

test("reports the same uses line when it is not inside a block scalar", () => {
  // The control for the block scalar tests: the same line outside a block
  // scalar is a pin, and the script reports it.
  const workflows = writeWorkflow(
    [
      "jobs:",
      "  build:",
      "    steps:",
      "      - name: example",
      BLOCK_SCALAR_BODY,
      "",
    ].join("\n"),
  );
  const result = runCheck([workflows]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /has 33 characters/);
});

test("accepts the workflow files of this repository", () => {
  const result = runCheck([]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^OK/m);
});

test("fails when the workflow directory does not exist", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "action-pins-"));
  temporaryDirectories.push(directory);
  const result = runCheck([path.join(directory, "missing")]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not exist/);
});

test("fails when more than one argument is given", () => {
  const workflows = writeWorkflow(workflowWith(`example/checkout@${FULL_SHA}`));
  const result = runCheck([workflows, workflows]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage: check-action-pins\.sh/);
});
