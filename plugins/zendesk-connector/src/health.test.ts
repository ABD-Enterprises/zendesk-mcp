import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { getConfig, type ZendeskConfig } from "./auth.js";
import { checkHealth, isHealthCheckRequested, runHealthCheck } from "./health.js";

const originalEnv = { ...process.env };
// The healthcheck validates the tool policy; an ambient read-only flag or
// allowlist would make these tests depend on the host environment.
function hostEnv(): NodeJS.ProcessEnv {
  const env = { ...originalEnv };
  delete env.ZENDESK_ALLOWED_TOOLS;
  delete env.ZENDESK_READ_ONLY;
  return env;
}
delete process.env.ZENDESK_ALLOWED_TOOLS;
delete process.env.ZENDESK_READ_ONLY;

afterEach(() => {
  process.env = { ...hostEnv() };
});

test("reports a missing configuration as a failure", () => {
  const result = checkHealth(() => {
    throw new Error("Zendesk connector is not configured.");
  });

  assert.deepEqual(result, {
    healthcheck: "fail",
    error: "Zendesk connector is not configured.",
  });
});

test("reports a structurally invalid configuration as a failure", () => {
  const result = checkHealth(() => ({
    baseUrl: "https://example.zendesk.com",
    mode: "not-a-mode",
  }));

  assert.equal(result.healthcheck, "fail");
  if (result.healthcheck === "fail") {
    assert.equal(
      result.error,
      "Zendesk OAuth configuration has no supported mode.",
    );
  }
});

test("accepts an access-token configuration", () => {
  const result = checkHealth(() => config());

  assert.deepEqual(result, { healthcheck: "ok" });
});

test("writes one ok line to stdout and exits zero", () => {
  const out: string[] = [];
  const err: string[] = [];

  const code = runHealthCheck({
    loadConfig: () => config(),
    writeOut: (line) => out.push(line),
    writeError: (line) => err.push(line),
  });

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out[0]), { healthcheck: "ok" });
  assert.equal(out.length, 1);
  assert.deepEqual(err, []);
});

test("writes one fail line to stderr and exits one", () => {
  const out: string[] = [];
  const err: string[] = [];

  const code = runHealthCheck({
    loadConfig: () => {
      throw new Error("Zendesk connector is not configured.");
    },
    writeOut: (line) => out.push(line),
    writeError: (line) => err.push(line),
  });

  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(err[0]), {
    healthcheck: "fail",
    error: "Zendesk connector is not configured.",
  });
  assert.equal(err.length, 1);
  assert.deepEqual(out, []);
});

test("never prints configuration values", () => {
  const out: string[] = [];
  const err: string[] = [];

  runHealthCheck({
    loadConfig: () => config(),
    writeOut: (line) => out.push(line),
    writeError: (line) => err.push(line),
  });

  const printed = [...out, ...err].join("");
  assert.ok(!printed.includes("invented-access-token"));
  assert.ok(!printed.includes("invented-client-secret"));
});

test("validates the configured OAuth environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zendesk-health-test-"));
  const clientFile = join(directory, "client.json");
  await writeFile(clientFile, JSON.stringify({ subdomain: "example" }), {
    mode: 0o600,
  });
  process.env = {
    ...hostEnv(),
    ZENDESK_OAUTH_CLIENT_FILE: clientFile,
    ZENDESK_SUBDOMAIN: "example",
    ZENDESK_OAUTH_ACCESS_TOKEN: "invented-access-token",
  };
  delete process.env.ZENDESK_BASE_URL;
  delete process.env.ZENDESK_OAUTH_MODE;
  delete process.env.ZENDESK_OAUTH_CLIENT_ID;
  delete process.env.ZENDESK_OAUTH_CLIENT_SECRET;

  assert.deepEqual(checkHealth(() => getConfig()), { healthcheck: "ok" });
});

test("rejects an OAuth client file readable by other users", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zendesk-health-test-"));
  const clientFile = join(directory, "client.json");
  await writeFile(clientFile, JSON.stringify({ subdomain: "example" }));
  // writeFile's mode is masked by umask, so set the permission explicitly.
  await chmod(clientFile, 0o644);
  process.env = {
    ...hostEnv(),
    ZENDESK_OAUTH_CLIENT_FILE: clientFile,
  };

  const result = checkHealth(() => getConfig());

  assert.equal(result.healthcheck, "fail");
  if (result.healthcheck === "fail") {
    assert.match(result.error, /chmod 600/);
  }
});

test("rejects an invalid read-only flag even when the OAuth config is valid", () => {
  process.env.ZENDESK_READ_ONLY = "yes";

  const result = checkHealth(() => config());

  assert.equal(result.healthcheck, "fail");
  if (result.healthcheck === "fail") {
    assert.match(result.error, /ZENDESK_READ_ONLY must be 1, true, 0, or false/);
  }
});

test("detects the healthcheck flag and environment variable", () => {
  assert.equal(isHealthCheckRequested(["--healthcheck"], {}), true);
  assert.equal(isHealthCheckRequested([], { ZENDESK_HEALTHCHECK: "1" }), true);
  assert.equal(isHealthCheckRequested([], { ZENDESK_HEALTHCHECK: "true" }), true);
  assert.equal(isHealthCheckRequested([], {}), false);
  assert.equal(isHealthCheckRequested(["--other"], {}), false);
});

function config(overrides: Partial<ZendeskConfig> = {}): ZendeskConfig {
  return {
    baseUrl: "https://example.zendesk.com",
    mode: "access_token",
    accessToken: "invented-access-token",
    clientId: "invented-client-id",
    clientSecret: "invented-client-secret",
    tokenFile: "/unused/oauth.json",
    scope: "read write",
    ...overrides,
  };
}
