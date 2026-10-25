import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { missingConfigNames, readConfig } from "../server.mjs";
import {
  CONFIG_ENV,
  applyConsoleConfig,
  clearConsoleConfig,
  setConsoleEnv,
} from "./helpers/console.mjs";

const originalEnv = { ...process.env };

beforeEach(() => {
  // Reading the configuration never reaches an account: point the console at a
  // client file that is not there.
  process.env.ZENDESK_OAUTH_CLIENT_FILE = join(tmpdir(), "operations-console-absent-client.json");
});

afterEach(() => {
  process.env = { ...originalEnv };
});

test("names every console setting that is missing", () => {
  clearConsoleConfig();

  // The console reports the name of every setting it is missing.
  assert.deepEqual(missingConfigNames(), Object.keys(CONFIG_ENV));
  assert.throws(
    () => readConfig(),
    (error) => {
      assert.match(error.message, /^Missing console configuration: /);
      for (const name of Object.keys(CONFIG_ENV)) {
        assert.ok(error.message.includes(name), `expected the error to name ${name}`);
      }
      return true;
    },
  );
});

test("names only the settings that are missing", () => {
  clearConsoleConfig();
  setConsoleEnv({ ZENDESK_CONSOLE_VIEW_AGING_ID: CONFIG_ENV.ZENDESK_CONSOLE_VIEW_AGING_ID });

  assert.deepEqual(
    missingConfigNames(),
    Object.keys(CONFIG_ENV).filter((name) => name !== "ZENDESK_CONSOLE_VIEW_AGING_ID"),
  );
  assert.throws(() => readConfig(), /Missing console configuration/);
});

test("treats an empty or blank setting as missing", () => {
  applyConsoleConfig();
  process.env.ZENDESK_CONSOLE_BRAND_ID = "";
  process.env.ZENDESK_CONSOLE_VIEW_OPEN_ID = "   ";

  assert.deepEqual(missingConfigNames(), [
    "ZENDESK_CONSOLE_BRAND_ID",
    "ZENDESK_CONSOLE_VIEW_OPEN_ID",
  ]);
  assert.throws(() => readConfig(), /Missing console configuration/);
});

test("trims the configured values", () => {
  applyConsoleConfig();
  process.env.ZENDESK_CONSOLE_BRAND_ID = "  900000000001  ";
  process.env.ZENDESK_CONSOLE_VIEW_UNTRIAGED_ID = "\t900000000005\n";

  assert.deepEqual(readConfig(), {
    brandId: "900000000001",
    requestTypeFieldId: CONFIG_ENV.ZENDESK_CONSOLE_REQUEST_TYPE_FIELD_ID,
    systemFieldId: CONFIG_ENV.ZENDESK_CONSOLE_SYSTEM_FIELD_ID,
    views: {
      open: CONFIG_ENV.ZENDESK_CONSOLE_VIEW_OPEN_ID,
      untriaged: "900000000005",
      aging: CONFIG_ENV.ZENDESK_CONSOLE_VIEW_AGING_ID,
      requestType: CONFIG_ENV.ZENDESK_CONSOLE_VIEW_REQUEST_TYPE_ID,
    },
  });
});

test("reads a complete configuration", () => {
  applyConsoleConfig();

  assert.deepEqual(missingConfigNames(), []);
  const config = readConfig();
  assert.equal(config.brandId, CONFIG_ENV.ZENDESK_CONSOLE_BRAND_ID);
  assert.equal(config.requestTypeFieldId, CONFIG_ENV.ZENDESK_CONSOLE_REQUEST_TYPE_FIELD_ID);
  assert.equal(config.systemFieldId, CONFIG_ENV.ZENDESK_CONSOLE_SYSTEM_FIELD_ID);
  assert.deepEqual(config.views, {
    open: CONFIG_ENV.ZENDESK_CONSOLE_VIEW_OPEN_ID,
    untriaged: CONFIG_ENV.ZENDESK_CONSOLE_VIEW_UNTRIAGED_ID,
    aging: CONFIG_ENV.ZENDESK_CONSOLE_VIEW_AGING_ID,
    requestType: CONFIG_ENV.ZENDESK_CONSOLE_VIEW_REQUEST_TYPE_ID,
  });
});
