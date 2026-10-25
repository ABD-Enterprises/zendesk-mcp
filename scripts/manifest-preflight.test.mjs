// Self-tests for the GHCR preflight classification in
// .github/scripts/check-manifest.sh.
//
// Usage:
//   node --test scripts/manifest-preflight.test.mjs
//
// The tests run the script as a subprocess, feed it a fixture registry answer
// on stdin and assert the exit code only: 0 when the answer proves that the
// manifest is unknown, 1 for every other answer. No network access and no
// Docker daemon are involved.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const SCRIPT_PATH = path.join(
  REPOSITORY_ROOT,
  ".github",
  "scripts",
  "check-manifest.sh",
);

function runScript(arguments_, input) {
  const result = spawnSync("bash", [SCRIPT_PATH, ...arguments_], {
    input,
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  return result.status;
}

function runPreflight(output, status) {
  return runScript([String(status)], output);
}

// Answers that prove the manifest does not exist. The rule is
// case-insensitive and treats underscores and spaces alike.
const UNKNOWN_MANIFEST_ANSWERS = [
  {
    name: "the docker manifest unknown answer",
    output: "no such manifest: manifest unknown",
  },
  {
    name: "the bare manifest unknown answer",
    output: "manifest unknown",
  },
  {
    name: "the no such manifest answer",
    output: "no such manifest",
  },
  {
    name: "the name unknown answer",
    output: "name unknown",
  },
  {
    name: "the upper case manifest unknown answer",
    output: "MANIFEST UNKNOWN",
  },
  {
    name: "the mixed case no such manifest answer",
    output: "No Such Manifest",
  },
  {
    name: "the mixed case name unknown answer",
    output: "Name Unknown",
  },
  {
    name: "the underscore separated manifest unknown answer",
    output: "MANIFEST_UNKNOWN",
  },
  {
    name: "the underscore separated no such manifest answer",
    output: "no_such_manifest",
  },
  {
    name: "the underscore separated name unknown answer",
    output: "NAME_UNKNOWN",
  },
  {
    name: "the client error that carries the answer",
    output:
      "error pulling image manifest: ghcr.io/example/example:1.0.0: manifest unknown",
  },
];

// Answers that prove nothing about the manifest. Each of them must abort.
const UNPROVEN_ANSWERS = [
  {
    name: "an empty answer",
    output: "",
  },
  {
    name: "a bare 404",
    output: "404",
  },
  {
    name: "a generic not found page",
    output: "404 page not found",
  },
  {
    name: "a generic not found text",
    output: "not found",
  },
  {
    name: "an internal server error",
    output: "500 Internal Server Error",
  },
  {
    name: "a service unavailable answer",
    output: "503 Service Unavailable",
  },
  {
    name: "a request timeout",
    output: "Client.Timeout exceeded while awaiting headers",
  },
  {
    name: "a handshake timeout",
    output: "net/http: TLS handshake timeout",
  },
  {
    name: "a name resolution failure",
    output: "dial tcp: lookup ghcr.io: no such host",
  },
  {
    name: "an underscore separated name resolution failure",
    output: "dial tcp: lookup ghcr.io: no_such_host",
  },
  {
    name: "an authentication failure",
    output: "unauthorized: authentication required",
  },
  {
    name: "a client error that names the manifest but not as unknown",
    output: "error parsing manifest: invalid JSON payload",
  },
  {
    name: "a random client error",
    output:
      "error response from daemon: driver failed programming external connectivity on endpoint",
  },
];

for (const answer of UNKNOWN_MANIFEST_ANSWERS) {
  test(`proceeds for ${answer.name}`, () => {
    assert.equal(runPreflight(answer.output, 1), 0);
  });
}

for (const answer of UNPROVEN_ANSWERS) {
  test(`aborts for ${answer.name}`, () => {
    assert.equal(runPreflight(answer.output, 1), 1);
  });
}

test("proceeds for a manifest unknown answer with another failing status", () => {
  assert.equal(runPreflight("manifest unknown", 22), 0);
});

test("aborts when the inspect status is missing", () => {
  assert.equal(runScript([], "manifest unknown"), 1);
});

test("aborts when the inspect status is not a number", () => {
  assert.equal(runScript(["not-a-number"], "manifest unknown"), 1);
});
