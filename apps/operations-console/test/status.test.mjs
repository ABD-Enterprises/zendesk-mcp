import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { resetCaches } from "../server.mjs";
import { startMockZendesk } from "./helpers/mock-zendesk.mjs";
import {
  CONFIG_ENV,
  applyConsoleConfig,
  clearConsoleConfig,
  getJson,
  startConsole,
  clearAccountEnv,
} from "./helpers/console.mjs";

const originalEnv = { ...process.env };

let mock;
let consoleServer;

before(async () => {
  consoleServer = await startConsole();
});

after(async () => {
  await consoleServer.close();
});

beforeEach(async () => {
  resetCaches();
  clearAccountEnv();
  // Every test reads its own mock account, so the recording it asserts on
  // holds the requests of that test only.
  mock = await startMockZendesk();
  // The status endpoint must never read an account: point the console at a
  // client file that is not there.
  process.env.ZENDESK_OAUTH_CLIENT_FILE = join(tmpdir(), "operations-console-absent-client.json");
});

afterEach(async () => {
  await mock?.close();
  process.env = { ...originalEnv };
});

test("reports a configured console", async () => {
  applyConsoleConfig();

  const { status, contentType, body } = await getJson(`${consoleServer.baseUrl}/api/status`);

  assert.equal(status, 200);
  assert.match(contentType, /application\/json/);
  assert.deepEqual(body, { ok: true, configured: true, missing: [] });
});

test("names the settings a console is missing", async () => {
  clearConsoleConfig();

  const { status, body } = await getJson(`${consoleServer.baseUrl}/api/status`);

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.configured, false);
  assert.deepEqual(body.missing, Object.keys(CONFIG_ENV));
});

test("reports a partially configured console", async () => {
  applyConsoleConfig({ ZENDESK_CONSOLE_VIEW_AGING_ID: undefined });

  const { status, body } = await getJson(`${consoleServer.baseUrl}/api/status`);

  assert.equal(status, 200);
  assert.equal(body.configured, false);
  assert.deepEqual(body.missing, ["ZENDESK_CONSOLE_VIEW_AGING_ID"]);
});

test("does not call the account to report its status", async () => {
  applyConsoleConfig();

  await getJson(`${consoleServer.baseUrl}/api/status`);

  assert.deepEqual(mock.state.tokenRequests, []);
  assert.deepEqual(mock.state.viewRequests, []);
  assert.deepEqual(mock.state.unknownRequests, []);
});
