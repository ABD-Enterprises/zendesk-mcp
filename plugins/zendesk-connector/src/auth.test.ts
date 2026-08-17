import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  ZendeskAuthError,
  ZendeskOAuth,
  getConfig,
  writeTokenFile,
  type ZendeskConfig,
} from "./auth.js";

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
});

test("getConfig ignores deprecated API-token credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zendesk-client-test-"));
  const clientFile = join(directory, "client.json");
  await writeFile(clientFile, JSON.stringify({ subdomain: "example" }), {
    mode: 0o600,
  });
  process.env = {
    ...originalEnv,
    ZENDESK_OAUTH_CLIENT_FILE: clientFile,
    ZENDESK_EMAIL: "agent@example.com",
    ZENDESK_API_TOKEN: "deprecated",
  };
  delete process.env.ZENDESK_OAUTH_MODE;
  delete process.env.ZENDESK_OAUTH_ACCESS_TOKEN;
  delete process.env.ZENDESK_OAUTH_CLIENT_ID;
  delete process.env.ZENDESK_OAUTH_CLIENT_SECRET;

  assert.throws(() => getConfig(), ZendeskAuthError);
});

test("getConfig reads an owner-only OAuth client file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zendesk-client-test-"));
  const clientFile = join(directory, "client.json");
  await writeFile(
    clientFile,
    JSON.stringify({
      subdomain: "tenant",
      mode: "authorization_code",
      clientId: "saved-client",
      clientSecret: "saved-secret",
      scope: "tickets:read",
    }),
    { mode: 0o600 },
  );
  process.env = {
    ...originalEnv,
    ZENDESK_OAUTH_CLIENT_FILE: clientFile,
  };
  delete process.env.ZENDESK_SUBDOMAIN;
  delete process.env.ZENDESK_BASE_URL;
  delete process.env.ZENDESK_OAUTH_MODE;
  delete process.env.ZENDESK_OAUTH_CLIENT_ID;
  delete process.env.ZENDESK_OAUTH_CLIENT_SECRET;
  delete process.env.ZENDESK_OAUTH_SCOPE;

  const loaded = getConfig();
  assert.equal(loaded.baseUrl, "https://tenant.zendesk.com");
  assert.equal(loaded.clientId, "saved-client");
  assert.equal(loaded.clientSecret, "saved-secret");
  assert.equal(loaded.scope, "tickets:read");
});

test("getConfig rejects an OAuth client file readable by other users", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zendesk-client-test-"));
  const clientFile = join(directory, "client.json");
  await writeFile(clientFile, JSON.stringify({ subdomain: "tenant" }), {
    mode: 0o644,
  });
  process.env = {
    ...originalEnv,
    ZENDESK_OAUTH_CLIENT_FILE: clientFile,
  };

  assert.throws(() => getConfig(), /chmod 600/);
});

test("access-token mode returns the configured bearer token", async () => {
  const auth = new ZendeskOAuth(config({
    mode: "access_token",
    accessToken: "bearer-token",
  }));

  assert.equal(await auth.getAccessToken(), "bearer-token");
  assert.equal(auth.canRefresh(), false);
});

test("client-credentials mode obtains and caches an access token", async () => {
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    assert.deepEqual(JSON.parse(String(init?.body)), {
      client_id: "client-id",
      client_secret: "client-secret",
      scope: "read write",
      expires_in: 3600,
      refresh_token_expires_in: 2592000,
      grant_type: "client_credentials",
    });
    return Response.json({ access_token: "service-token", expires_in: 3600 });
  };
  const auth = new ZendeskOAuth(config({ mode: "client_credentials" }));

  assert.equal(await auth.getAccessToken(), "service-token");
  assert.equal(await auth.getAccessToken(), "service-token");
  assert.equal(calls, 1);
});

test("authorization-code mode rotates and persists refresh tokens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zendesk-oauth-test-"));
  const tokenFile = join(directory, "oauth.json");
  await writeTokenFile(tokenFile, {
    access_token: "expired-token",
    refresh_token: "old-refresh-token",
    expires_at: new Date(0).toISOString(),
  });

  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.grant_type, "refresh_token");
    assert.equal(body.refresh_token, "old-refresh-token");
    return Response.json({
      access_token: "new-token",
      refresh_token: "new-refresh-token",
      expires_in: 3600,
    });
  };

  const auth = new ZendeskOAuth(
    config({ mode: "authorization_code", tokenFile }),
  );
  assert.equal(await auth.getAccessToken(), "new-token");

  const persisted = JSON.parse(await readFile(tokenFile, "utf8"));
  assert.equal(persisted.access_token, "new-token");
  assert.equal(persisted.refresh_token, "new-refresh-token");
  assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
});

function config(overrides: Partial<ZendeskConfig>): ZendeskConfig {
  return {
    baseUrl: "https://example.zendesk.com",
    mode: "authorization_code",
    clientId: "client-id",
    clientSecret: "client-secret",
    tokenFile: "/unused/oauth.json",
    scope: "read write",
    ...overrides,
  };
}
