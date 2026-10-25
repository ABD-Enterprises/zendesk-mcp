// Self-tests for the release tag guards in
// .github/scripts/check-release-tag.sh.
//
// Usage:
//   node --test scripts/release-tag.test.mjs
//
// The tests run the script as a subprocess against fixture package files
// written to a temporary directory. No network access, no Git repository and
// no GitHub account are involved.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  "check-release-tag.sh",
);
const REPOSITORY_PACKAGE_FILE = path.join(
  REPOSITORY_ROOT,
  "plugins",
  "zendesk-connector",
  "package.json",
);

const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Writes a fixture package file that carries the given version.
function writePackageFile(version, contents) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "release-tag-"));
  temporaryDirectories.push(directory);
  const file = path.join(directory, "package.json");
  const text =
    contents === undefined
      ? `${JSON.stringify({ name: "example-package", version }, null, 2)}\n`
      : contents;
  writeFileSync(file, text, "utf8");
  return file;
}

function runScript(arguments_) {
  const result = spawnSync("bash", [SCRIPT_PATH, ...arguments_], {
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function runCheck(tag, packageFile, ancestorOk) {
  return runScript([tag, packageFile, ancestorOk]);
}

// Every diagnostic of the script starts with this prefix.
function diagnostics(result) {
  return result.stderr
    .split("\n")
    .filter((line) => line.startsWith("Refusing to publish:"));
}

test("accepts a tag that matches the package version", () => {
  const packageFile = writePackageFile("1.2.3");
  const result = runCheck("v1.2.3", packageFile, "1");
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /matches package version '1\.2\.3'/);
});

test("rejects a tag that does not match the package version", () => {
  const packageFile = writePackageFile("2.3.4");
  const result = runCheck("v1.2.3", packageFile, "1");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match package version '2\.3\.4'/);
  assert.equal(diagnostics(result).length, 1);
});

test("rejects a tag without the v prefix", () => {
  const packageFile = writePackageFile("1.2.3");
  const result = runCheck("1.2.3", packageFile, "1");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not have the shape/);
  assert.equal(diagnostics(result).length, 1);
});

// Tags that do not have the shape v<major>.<minor>.<patch> with an optional
// pre-release suffix.
const MALFORMED_TAGS = [
  "v1.2",
  "v1.2.x",
  "v1.2.3-",
  "v1.2.3+build",
  "v",
  "vv1.2.3",
  // A fourth number is not a version: the suffix of a version starts with a
  // dash, so "v1.2.3.4" is no version at all.
  "v1.2.3.4",
  "v1.2.3.4.5",
  "v1.2.3.rc",
];

for (const tag of MALFORMED_TAGS) {
  test(`rejects the malformed tag '${tag}'`, () => {
    const packageFile = writePackageFile("1.2.3");
    const result = runCheck(tag, packageFile, "1");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not have the shape/);
  });
}

test("rejects a tag with a fourth number even when the package file carries it", () => {
  const packageFile = writePackageFile("1.2.3.4");
  const result = runCheck("v1.2.3.4", packageFile, "1");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not have the shape/);
  assert.equal(diagnostics(result).length, 1);
});

test("rejects a release commit that is not on main", () => {
  const packageFile = writePackageFile("1.2.3");
  const result = runCheck("v1.2.3", packageFile, "0");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not an ancestor of origin\/main/);
  assert.equal(diagnostics(result).length, 1);
});

test("rejects an ancestry result that is neither 0 nor 1", () => {
  const packageFile = writePackageFile("1.2.3");
  const result = runCheck("v1.2.3", packageFile, "yes");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /neither 0 nor 1/);
});

test("accepts a pre-release tag", () => {
  const packageFile = writePackageFile("1.2.3-rc.1");
  const result = runCheck("v1.2.3-rc.1", packageFile, "1");
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /matches package version '1\.2\.3-rc\.1'/);
});

test("reports every violated condition", () => {
  // The tag has the wrong shape, it does not match the package version and
  // the release commit is not on main. All three conditions are reported.
  const packageFile = writePackageFile("9.9.9");
  const result = runCheck("v1.2", packageFile, "0");
  assert.equal(result.status, 1);
  const reports = diagnostics(result);
  assert.equal(reports.length, 3);
  assert.ok(reports.some((line) => /does not have the shape/.test(line)));
  assert.ok(
    reports.some((line) => /does not match package version '9\.9\.9'/.test(line)),
  );
  assert.ok(reports.some((line) => /not an ancestor of origin\/main/.test(line)));
});

test("reads the version from a package file with unusual whitespace", () => {
  const packageFile = writePackageFile(
    undefined,
    '{\n\t"name": "example-package",\n\t"version"  :  "1.2.3"\n}\n\n',
  );
  const result = runCheck("v1.2.3", packageFile, "1");
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("compares the version exactly", () => {
  const packageFile = writePackageFile("1.2.3 ");
  const result = runCheck("v1.2.3", packageFile, "1");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match package version '1\.2\.3 '/);
});

test("rejects a package version that ends in a newline", () => {
  // The newline belongs to the version string. A shell command substitution
  // drops it, and the version would then compare as if it had none.
  const packageFile = writePackageFile(
    undefined,
    `${JSON.stringify({ name: "example-package", version: "1.2.3\n" })}\n`,
  );
  const result = runCheck("v1.2.3", packageFile, "1");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match package version '1\.2\.3\\n'/);
  assert.equal(diagnostics(result).length, 1);
});

test("rejects a package version that ends in a tab", () => {
  const packageFile = writePackageFile(
    undefined,
    `${JSON.stringify({ name: "example-package", version: "1.2.3\t" })}\n`,
  );
  const result = runCheck("v1.2.3", packageFile, "1");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match package version '1\.2\.3\\t'/);
  assert.equal(diagnostics(result).length, 1);
});

test("rejects a package file that does not exist", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "release-tag-"));
  temporaryDirectories.push(directory);
  const result = runCheck("v1.2.3", path.join(directory, "missing.json"), "1");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not be read/);
});

test("rejects a package file without a version", () => {
  const packageFile = writePackageFile(
    undefined,
    `${JSON.stringify({ name: "example-package" })}\n`,
  );
  const result = runCheck("v1.2.3", packageFile, "1");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not be read/);
});

test("rejects a package file that is not valid JSON", () => {
  const packageFile = writePackageFile(undefined, "not json at all\n");
  const result = runCheck("v1.2.3", packageFile, "1");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not be read/);
});

test("fails when the number of arguments is wrong", () => {
  const packageFile = writePackageFile("1.2.3");
  for (const arguments_ of [[], ["v1.2.3"], ["v1.2.3", packageFile]]) {
    const result = runScript(arguments_);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /usage: check-release-tag\.sh/);
  }
});

test("accepts the tag that matches the version of this repository", () => {
  const version = JSON.parse(
    readFileSync(REPOSITORY_PACKAGE_FILE, "utf8"),
  ).version;
  const result = runCheck(`v${version}`, REPOSITORY_PACKAGE_FILE, "1");
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});
