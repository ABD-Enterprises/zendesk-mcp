/**
 * Shared helpers for the console test suite: the console app on an ephemeral
 * port, a temporary OAuth client file that points at the mock account, and
 * the environment handling the console reads its configuration from.
 *
 * Every value here is invented. Nothing in this suite reaches a live account
 * or the public internet.
 */
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "../../server.mjs";

// The console settings, in the order the server declares them.
export const CONFIG_ENV = {
  ZENDESK_CONSOLE_BRAND_ID: "900000000001",
  ZENDESK_CONSOLE_REQUEST_TYPE_FIELD_ID: "900000000002",
  ZENDESK_CONSOLE_SYSTEM_FIELD_ID: "900000000003",
  ZENDESK_CONSOLE_VIEW_OPEN_ID: "900000000004",
  ZENDESK_CONSOLE_VIEW_UNTRIAGED_ID: "900000000005",
  ZENDESK_CONSOLE_VIEW_AGING_ID: "900000000006",
  ZENDESK_CONSOLE_VIEW_REQUEST_TYPE_ID: "900000000007",
};

export const AGING_VIEW_ID = CONFIG_ENV.ZENDESK_CONSOLE_VIEW_AGING_ID;
export const UNTRIAGED_VIEW_ID = CONFIG_ENV.ZENDESK_CONSOLE_VIEW_UNTRIAGED_ID;

// The settings the dashboard itself needs. A missing one of these makes the
// dashboard unavailable.
export const REQUIRED_CONFIG_ENV = [
  "ZENDESK_CONSOLE_BRAND_ID",
  "ZENDESK_CONSOLE_REQUEST_TYPE_FIELD_ID",
  "ZENDESK_CONSOLE_SYSTEM_FIELD_ID",
  "ZENDESK_CONSOLE_VIEW_UNTRIAGED_ID",
  "ZENDESK_CONSOLE_VIEW_AGING_ID",
];

// The settings that only build a link into the account. A missing one of
// these costs a link, not the dashboard.
export const LINK_CONFIG_ENV = [
  "ZENDESK_CONSOLE_VIEW_OPEN_ID",
  "ZENDESK_CONSOLE_VIEW_REQUEST_TYPE_ID",
];
export const REQUEST_TYPE_FIELD_ID = CONFIG_ENV.ZENDESK_CONSOLE_REQUEST_TYPE_FIELD_ID;
export const SYSTEM_FIELD_ID = CONFIG_ENV.ZENDESK_CONSOLE_SYSTEM_FIELD_ID;

export const CLIENT = {
  clientId: "invented-client-id",
  clientSecret: "invented-client-secret",
};

export const ACCESS_TOKEN = "invented-access-token";

// Removes the account settings a host may export. The console reads the
// scope from the environment, so an exported value would decide what the
// tests ask for; the account comes from the client file, and the tests point
// that at their own mock.
export function clearAccountEnv() {
  delete process.env.ZENDESK_OAUTH_SCOPE;
  delete process.env.ZENDESK_CONSOLE_OAUTH_SCOPE;
  delete process.env.ZENDESK_CONSOLE_ALLOWED_HOSTS;
  delete process.env.ZENDESK_BASE_URL;
  delete process.env.ZENDESK_SUBDOMAIN;
}

// Sets every console setting, overriding the ones given. A value of undefined
// removes the setting.
export function applyConsoleConfig(overrides = {}) {
  for (const [name, value] of Object.entries({ ...CONFIG_ENV, ...overrides })) {
    setEnv(name, value);
  }
}

// Removes every console setting.
export function clearConsoleConfig() {
  applyConsoleConfig(
    Object.fromEntries(Object.keys(CONFIG_ENV).map((name) => [name, undefined])),
  );
}

// Sets only the given console settings.
export function setConsoleEnv(values) {
  for (const [name, value] of Object.entries(values)) {
    setEnv(name, value);
  }
}

function setEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

// Creates a temporary directory that the caller removes again.
export async function makeTempDir(prefix = "operations-console-test-") {
  return mkdtemp(join(tmpdir(), prefix));
}

// Removes a directory created by makeTempDir.
export async function removeTempDir(directory) {
  await rm(directory, { recursive: true, force: true });
}

// Writes the OAuth client file the console reads. The contents may be a
// string, so a test can write a malformed file.
export async function writeClientFile(directory, contents) {
  const file = join(directory, "client.json");
  const body = typeof contents === "string" ? contents : JSON.stringify(contents);
  await writeFile(file, body, { mode: 0o600 });
  return file;
}

// The client file the console reads, pointed at the mock account.
export function clientFileFor(baseUrl) {
  return {
    baseUrl,
    clientId: CLIENT.clientId,
    clientSecret: CLIENT.clientSecret,
  };
}

// Starts the console app on 127.0.0.1 with an ephemeral port.
export async function startConsole() {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

// Reads a JSON answer from the console.
export async function getJson(url) {
  const response = await fetch(url);
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.json(),
  };
}
