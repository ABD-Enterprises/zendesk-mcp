import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  isValidCallbackPort,
  resolveCallbackPort,
  sameFilePath,
  ZendeskAuthError,
  ZendeskOAuth,
  getConfig,
  removeTokenFile,
  revokeCurrentToken,
  writeTokenFile,
  type ZendeskConfig,
} from "./auth.js";
import { ZendeskClient } from "./client.js";

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
  await writeFile(clientFile, JSON.stringify({ subdomain: "tenant" }));
  // writeFile's mode is masked by umask, so set the permission explicitly.
  await chmod(clientFile, 0o644);
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

test("revokeCurrentToken deletes the current token and reports success", async () => {
  const requests: RecordedRequest[] = [];
  const client = new ZendeskClient(
    config({ mode: "access_token", accessToken: "invented-access-token" }),
    recordingFetcher(requests),
  );

  const result = await revokeCurrentToken((path, options) =>
    client.request(path, options),
  );

  assert.deepEqual(result, { revoked: true });
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://example.zendesk.com/api/v2/oauth/tokens/current",
  );
  assert.equal(requests[0].method, "DELETE");
  assert.equal(requests[0].authorization, "Bearer invented-access-token");
});

test("revokeCurrentToken reports a rejected revocation without throwing", async () => {
  const requests: RecordedRequest[] = [];
  const client = new ZendeskClient(
    config({ mode: "access_token", accessToken: "invented-access-token" }),
    recordingFetcher(requests, () =>
      Response.json(
        { error: "forbidden" },
        { status: 403, statusText: "Forbidden" },
      ),
    ),
  );

  const result = await revokeCurrentToken((path, options) =>
    client.request(path, options),
  );

  assert.equal(result.revoked, false);
  assert.equal(result.status, 403);
  assert.match(result.error ?? "", /HTTP 403/);
});

test("revokeCurrentToken reports a failed request without throwing", async () => {
  const requests: RecordedRequest[] = [];
  const client = new ZendeskClient(
    config({ mode: "access_token", accessToken: "invented-access-token" }),
    recordingFetcher(requests, () => {
      throw new Error("network unavailable");
    }),
  );

  const result = await revokeCurrentToken((path, options) =>
    client.request(path, options),
  );

  assert.equal(result.revoked, false);
  assert.equal(result.status, undefined);
  assert.match(result.error ?? "", /network unavailable/);
});

test("removeTokenFile removes the stored token and tolerates a missing file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zendesk-oauth-test-"));
  const tokenFile = join(directory, "oauth.json");
  await writeTokenFile(tokenFile, { access_token: "invented-access-token" });

  assert.equal(await removeTokenFile(tokenFile), true);
  assert.equal(await removeTokenFile(tokenFile), false);
});

test("resolveCallbackPort reads only trimmed decimal digits", () => {
  // The parser is shared by oauth:setup and the doctor, so every spelling
  // must bind the same port — or the same error — in both.
  delete process.env.ZENDESK_OAUTH_CALLBACK_PORT;
  assert.equal(resolveCallbackPort(), 3219);

  const cases: ReadonlyArray<readonly [string, number, boolean]> = [
    // value, resolveCallbackPort(), isValidCallbackPort() of that result
    ["3219", 3219, true],
    [" 3219 ", 3219, true],
    ["1", 1, true],
    ["65535", 65535, true],
    ["0", 0, false],
    ["65536", 65536, false],
    ["0x10", Number.NaN, false],
    ["1e3", Number.NaN, false],
    ["+3219", Number.NaN, false],
    ["3219.0", Number.NaN, false],
    ["", Number.NaN, false],
    ["${PORT}", Number.NaN, false],
  ];
  for (const [value, expectedPort, expectedValid] of cases) {
    process.env.ZENDESK_OAUTH_CALLBACK_PORT = value;
    const port = resolveCallbackPort();
    if (Number.isNaN(expectedPort)) {
      assert.ok(Number.isNaN(port), `value ${JSON.stringify(value)} must not parse`);
    } else {
      assert.equal(port, expectedPort, `value ${JSON.stringify(value)}`);
    }
    // The pair must agree: a spelling the parser rejects fails the shared
    // validity check, so both consumers report CALLBACK_PORT_ERROR instead
    // of binding a port nobody registered as the callback URL.
    assert.equal(
      isValidCallbackPort(port),
      expectedValid,
      `value ${JSON.stringify(value)}`,
    );
  }
});

test("isValidCallbackPort accepts only integers within the TCP range", () => {
  assert.equal(isValidCallbackPort(1), true);
  assert.equal(isValidCallbackPort(65535), true);
  assert.equal(isValidCallbackPort(0), false);
  assert.equal(isValidCallbackPort(65536), false);
  assert.equal(isValidCallbackPort(3219.5), false);
  assert.equal(isValidCallbackPort(Number.NaN), false);
});

test("sameFilePath treats a non-string path as no match instead of throwing", () => {
  // The client file may hold any JSON value for tokenFile, and the guard runs
  // before the caller's own read reports it — a wrong-typed value must come
  // back as "not the same file", never as a raw TypeError.
  assert.equal(sameFilePath(123 as unknown as string, "example-client.json"), false);
  assert.equal(sameFilePath("example-token.json", {} as unknown as string), false);
  assert.equal(sameFilePath(undefined as unknown as string, "example-token.json"), false);
});

interface RecordedRequest {
  url: string;
  method?: string;
  authorization: string | null;
}

function recordingFetcher(
  requests: RecordedRequest[],
  respond: () => Response = () => new Response(null, { status: 204 }),
): typeof fetch {
  return async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return respond();
  };
}

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