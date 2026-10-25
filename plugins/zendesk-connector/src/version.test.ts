import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PACKAGE_VERSION } from "./version.js";

function readJson(url: URL): Record<string, unknown> {
  return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
}

const packageJson = readJson(new URL("../package.json", import.meta.url));

test("reports the version declared in package.json", () => {
  assert.equal(PACKAGE_VERSION, packageJson.version);
});

test("reports a semantic version", () => {
  assert.match(
    PACKAGE_VERSION,
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  );
});

test("keeps the Codex plugin manifest version in step with package.json", () => {
  const pluginJson = readJson(
    new URL("../.codex-plugin/plugin.json", import.meta.url),
  );
  assert.equal(pluginJson.version, packageJson.version);
});
