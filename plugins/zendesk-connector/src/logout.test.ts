import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  ZendeskOAuth,
  writeTokenFile,
  type ZendeskConfig,
} from "./auth.js";
import { ZendeskLogout, isLogoutRequested, runLogout } from "./logout.js";

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
});

test("revokes the token and clears the local credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zendesk-logout-test-"));
  const tokenFile = join(directory, "oauth.json");
  const clientFile = join(directory, "client.json");
  await writeTokenFile(tokenFile, {
    access_token: "invented-access-token",
    refresh_token: "invented-refresh-token",
  });
  await writeFile(
    clientFile,
    JSON.stringify({ clientId: "invented-client-id" }),
    { mode: 0o600 },
  );
  process.env.ZENDESK_OAUTH_CLIENT_FILE = clientFile;

  const requests: RecordedRequest[] = [];
  globalThis.fetch = recordingFetcher(requests);

  const auth = new ZendeskOAuth(config({ tokenFile }));
  assert.equal(await auth.getAccessToken(), "invented-access-token");

  const lines: string[] = [];
  const result = await new ZendeskLogout({
    config: config({ tokenFile }),
    auth,
    sink: (line) => lines.push(line),
  }).run();

  assert.equal(result.revoked, true);
  assert.equal(result.cacheCleared, true);
  assert.equal(result.storedCredentials, "removed");
  assert.equal(result.mode, "authorization_code");
  assert.equal(result.error, undefined);

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://example.zendesk.com/api/v2/oauth/tokens/current",
  );
  assert.equal(requests[0].method, "DELETE");
  assert.equal(requests[0].authorization, "Bearer invented-access-token");

  await assert.rejects(() => readFile(tokenFile, "utf8"), /ENOENT/);
  assert.ok((await stat(clientFile)).isFile());
  assert.equal(
    JSON.parse(await readFile(clientFile, "utf8")).clientId,
    "invented-client-id",
  );
  await assert.rejects(() => auth.getAccessToken(), /logged out/);

  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.event, "zendesk_oauth_logout");
  assert.equal(event.outcome, "success");
  assert.equal(event.revoked, true);
  assert.equal(event.clearedCache, true);
  assert.equal(event.storedCredentials, "removed");
  assert.equal(event.mode, "authorization_code");
  assert.ok(!lines[0].includes("invented-access-token"));
  assert.ok(!lines[0].includes("invented-refresh-token"));
});

test("clears the local credentials when Zendesk rejects the revocation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zendesk-logout-test-"));
  const tokenFile = join(directory, "oauth.json");
  const clientFile = join(directory, "client.json");
  await writeTokenFile(tokenFile, { access_token: "invented-access-token" });
  await writeFile(
    clientFile,
    JSON.stringify({ clientId: "invented-client-id" }),
    { mode: 0o600 },
  );
  process.env.ZENDESK_OAUTH_CLIENT_FILE = clientFile;

  globalThis.fetch = recordingFetcher([], () =>
    Response.json({ error: "forbidden" }, { status: 403, statusText: "Forbidden" }),
  );

  const lines: string[] = [];
  const result = await new ZendeskLogout({
    config: config({ tokenFile }),
    sink: (line) => lines.push(line),
  }).run();

  assert.equal(result.revoked, false);
  assert.equal(result.status, 403);
  assert.equal(result.storedCredentials, "removed");
  assert.match(result.error ?? "", /HTTP 403/);

  await assert.rejects(() => readFile(tokenFile, "utf8"), /ENOENT/);
  assert.ok((await stat(clientFile)).isFile());

  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.outcome, "error");
  assert.equal(event.revoked, false);
  assert.equal(event.status, 403);
  assert.equal(event.storedCredentials, "removed");
});

test("clears the local credentials when the revocation request fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zendesk-logout-test-"));
  const tokenFile = join(directory, "oauth.json");
  const clientFile = join(directory, "client.json");
  await writeTokenFile(tokenFile, { access_token: "invented-access-token" });
  await writeFile(
    clientFile,
    JSON.stringify({ clientId: "invented-client-id" }),
    { mode: 0o600 },
  );
  process.env.ZENDESK_OAUTH_CLIENT_FILE = clientFile;

  globalThis.fetch = recordingFetcher([], () => {
    throw new Error("network unavailable");
  });

  const lines: string[] = [];
  const result = await new ZendeskLogout({
    config: config({ tokenFile }),
    sink: (line) => lines.push(line),
  }).run();

  assert.equal(result.revoked, false);
  assert.equal(result.status, undefined);
  assert.equal(result.storedCredentials, "removed");
  assert.match(result.error ?? "", /network unavailable/);

  await assert.rejects(() => readFile(tokenFile, "utf8"), /ENOENT/);
  assert.ok((await stat(clientFile)).isFile());

  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.outcome, "error");
  assert.equal(event.revoked, false);
  assert.equal(event.storedCredentials, "removed");
});

test("revokes and audits once for concurrent logout calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zendesk-logout-test-"));
  const tokenFile = join(directory, "oauth.json");
  await writeTokenFile(tokenFile, { access_token: "invented-access-token" });

  const requests: RecordedRequest[] = [];
  globalThis.fetch = recordingFetcher(requests);

  const lines: string[] = [];
  const logout = new ZendeskLogout({
    config: config({ tokenFile }),
    sink: (line) => lines.push(line),
  });
  const [first, second] = await Promise.all([logout.run(), logout.run()]);

  assert.deepEqual(first, second);
  assert.equal(requests.length, 1);
  assert.equal(lines.length, 1);
  await assert.rejects(() => readFile(tokenFile, "utf8"), /ENOENT/);
});

test("never removes the OAuth client file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zendesk-logout-test-"));
  const clientFile = join(directory, "client.json");
  await writeFile(
    clientFile,
    JSON.stringify({ clientId: "invented-client-id" }),
    { mode: 0o600 },
  );
  process.env.ZENDESK_OAUTH_CLIENT_FILE = clientFile;

  globalThis.fetch = recordingFetcher([]);

  const lines: string[] = [];
  const result = await new ZendeskLogout({
    config: config({ tokenFile: clientFile }),
    sink: (line) => lines.push(line),
  }).run();

  assert.equal(result.storedCredentials, "kept");
  assert.match(result.error ?? "", /client file/);
  assert.ok((await stat(clientFile)).isFile());
  assert.equal(
    JSON.parse(await readFile(clientFile, "utf8")).clientId,
    "invented-client-id",
  );

  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.outcome, "error");
  assert.equal(event.storedCredentials, "kept");
});

test("never removes the OAuth client file spelled with different case", async (ctx) => {
  const directory = await mkdtemp(join(tmpdir(), "zendesk-logout-test-"));
  const clientFile = join(directory, "client.json");
  await writeFile(
    clientFile,
    JSON.stringify({ clientId: "invented-client-id" }),
    { mode: 0o600 },
  );
  // On a case-insensitive volume the two spellings are one file, so deleting
  // through the variant deletes the client credentials. The probe decides
  // whether this host's volume folds case, so the assertion holds anywhere.
  const variant = join(directory, "Client.json");
  try {
    await stat(variant);
  } catch {
    ctx.skip("this volume is case-sensitive");
    return;
  }
  process.env.ZENDESK_OAUTH_CLIENT_FILE = clientFile;

  globalThis.fetch = recordingFetcher([], () => {
    throw new Error("the tests never reach the network");
  });

  const lines: string[] = [];
  const result = await new ZendeskLogout({
    config: config({ tokenFile: variant }),
    sink: (line) => lines.push(line),
  }).run();

  assert.equal(result.storedCredentials, "kept");
  assert.match(result.error ?? "", /client file/);
  assert.ok((await stat(clientFile)).isFile());
  assert.equal(
    JSON.parse(await readFile(clientFile, "utf8")).clientId,
    "invented-client-id",
  );

  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.storedCredentials, "kept");
});

test("clears the stored credentials when the configuration is incomplete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zendesk-logout-test-"));
  const tokenFile = join(directory, "oauth.json");
  const clientFile = join(directory, "client.json");
  await writeTokenFile(tokenFile, { access_token: "invented-access-token" });
  await writeFile(clientFile, JSON.stringify({}), { mode: 0o600 });

  process.env = {
    ...originalEnv,
    ZENDESK_OAUTH_CLIENT_FILE: clientFile,
    ZENDESK_OAUTH_TOKEN_FILE: tokenFile,
  };
  delete process.env.ZENDESK_SUBDOMAIN;
  delete process.env.ZENDESK_BASE_URL;
  delete process.env.ZENDESK_OAUTH_CLIENT_ID;
  delete process.env.ZENDESK_OAUTH_CLIENT_SECRET;
  delete process.env.ZENDESK_OAUTH_ACCESS_TOKEN;
  delete process.env.ZENDESK_OAUTH_MODE;
  globalThis.fetch = recordingFetcher([], () => {
    throw new Error("the tests never reach the network");
  });

  const lines: string[] = [];
  const result = await new ZendeskLogout({
    sink: (line) => lines.push(line),
  }).run();

  assert.equal(result.revoked, false);
  assert.equal(result.storedCredentials, "removed");
  assert.match(result.error ?? "", /configuration is unavailable/);
  await assert.rejects(() => readFile(tokenFile, "utf8"), /ENOENT/);

  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.outcome, "error");
  assert.equal(event.storedCredentials, "removed");
});

test("clears the token file the client file names when the configuration is incomplete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zendesk-logout-test-"));
  const home = join(directory, "home");
  const tokenFile = join(directory, "named-oauth.json");
  const clientFile = join(directory, "client.json");
  const defaultTokenFile = join(home, ".config", "codex-zendesk", "oauth.json");
  await writeTokenFile(tokenFile, { access_token: "invented-access-token" });
  // A decoy at the default path proves the fallback clears only the file the
  // configuration names — a regression that removed both must fail here.
  await writeTokenFile(defaultTokenFile, {
    access_token: "invented-stale-token",
  });
  // The client file names the token file, but the configuration is otherwise
  // incomplete (no subdomain), so getConfig throws and the fallback decides
  // which file is cleared. HOME points into the fixture, so the default path
  // a regression would pick is inside the fixture too — never the real one.
  await writeFile(
    clientFile,
    JSON.stringify({
      clientId: "invented-client-id",
      clientSecret: "invented-client-secret",
      mode: "authorization_code",
      tokenFile,
    }),
    { mode: 0o600 },
  );

  process.env = {
    ...originalEnv,
    HOME: home,
    USERPROFILE: home,
    ZENDESK_OAUTH_CLIENT_FILE: clientFile,
  };
  delete process.env.ZENDESK_OAUTH_TOKEN_FILE;
  delete process.env.ZENDESK_SUBDOMAIN;
  delete process.env.ZENDESK_BASE_URL;
  delete process.env.ZENDESK_OAUTH_CLIENT_ID;
  delete process.env.ZENDESK_OAUTH_CLIENT_SECRET;
  delete process.env.ZENDESK_OAUTH_ACCESS_TOKEN;
  delete process.env.ZENDESK_OAUTH_MODE;
  globalThis.fetch = recordingFetcher([], () => {
    throw new Error("the tests never reach the network");
  });

  const lines: string[] = [];
  const result = await new ZendeskLogout({
    sink: (line) => lines.push(line),
  }).run();

  // The file the configuration names is cleared — not the default path,
  // which the connector never wrote to.
  assert.equal(result.revoked, false);
  assert.equal(result.storedCredentials, "removed");
  assert.match(result.error ?? "", /configuration is unavailable/);
  await assert.rejects(() => readFile(tokenFile, "utf8"), /ENOENT/);
  assert.ok((await stat(defaultTokenFile)).isFile());
  assert.equal(
    JSON.parse(await readFile(defaultTokenFile, "utf8")).access_token,
    "invented-stale-token",
  );

  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.storedCredentials, "removed");
});

test("clears the token file a loose-permission client file names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zendesk-logout-test-"));
  const home = join(directory, "home");
  const tokenFile = join(directory, "named-oauth.json");
  const clientFile = join(directory, "client.json");
  const defaultTokenFile = join(home, ".config", "codex-zendesk", "oauth.json");
  await writeTokenFile(tokenFile, { access_token: "invented-access-token" });
  await writeTokenFile(defaultTokenFile, {
    access_token: "invented-stale-token",
  });
  // The client file fails getConfig's permission check, so the configuration
  // is unusable — but its tokenFile field is just a path, not secret
  // material, and the lenient fallback still reads it: logout must remove
  // that file, not the default the connector never wrote.
  await writeFile(
    clientFile,
    JSON.stringify({
      clientId: "invented-client-id",
      clientSecret: "invented-client-secret",
      mode: "authorization_code",
      tokenFile,
    }),
  );
  await chmod(clientFile, 0o644);

  process.env = {
    ...originalEnv,
    HOME: home,
    USERPROFILE: home,
    ZENDESK_OAUTH_CLIENT_FILE: clientFile,
  };
  delete process.env.ZENDESK_OAUTH_TOKEN_FILE;
  delete process.env.ZENDESK_SUBDOMAIN;
  delete process.env.ZENDESK_BASE_URL;
  delete process.env.ZENDESK_OAUTH_CLIENT_ID;
  delete process.env.ZENDESK_OAUTH_CLIENT_SECRET;
  delete process.env.ZENDESK_OAUTH_ACCESS_TOKEN;
  delete process.env.ZENDESK_OAUTH_MODE;
  globalThis.fetch = recordingFetcher([], () => {
    throw new Error("the tests never reach the network");
  });

  const result = await new ZendeskLogout({ sink: () => {} }).run();

  assert.equal(result.storedCredentials, "removed");
  assert.match(result.error ?? "", /chmod 600/);
  await assert.rejects(() => readFile(tokenFile, "utf8"), /ENOENT/);
  assert.ok((await stat(defaultTokenFile)).isFile());
});

test("clears the local credentials when the client file holds a non-string tokenFile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zendesk-logout-test-"));
  const tokenFile = join(directory, "oauth.json");
  const clientFile = join(directory, "client.json");
  await writeTokenFile(tokenFile, { access_token: "invented-access-token" });
  await writeFile(
    clientFile,
    JSON.stringify({
      subdomain: "example",
      clientId: "invented-client-id",
      clientSecret: "invented-client-secret",
      mode: "authorization_code",
      tokenFile: 123,
    }),
    { mode: 0o600 },
  );

  process.env = {
    ...originalEnv,
    ZENDESK_OAUTH_CLIENT_FILE: clientFile,
    ZENDESK_OAUTH_TOKEN_FILE: tokenFile,
  };
  delete process.env.ZENDESK_SUBDOMAIN;
  delete process.env.ZENDESK_BASE_URL;
  delete process.env.ZENDESK_OAUTH_CLIENT_ID;
  delete process.env.ZENDESK_OAUTH_CLIENT_SECRET;
  delete process.env.ZENDESK_OAUTH_ACCESS_TOKEN;
  delete process.env.ZENDESK_OAUTH_MODE;
  globalThis.fetch = recordingFetcher([], () => {
    throw new Error("the tests never reach the network");
  });

  const lines: string[] = [];
  const result = await new ZendeskLogout({
    sink: (line) => lines.push(line),
  }).run();

  // getConfig rejects the wrong-typed field with a normal configuration
  // error, so logout reports it instead of crashing on a non-string path —
  // and, as with any unusable configuration, the local credentials the
  // resolved path names are still cleared.
  assert.match(result.error ?? "", /"tokenFile" value that must be a non-empty path string/);
  assert.equal(result.revoked, false);
  assert.equal(result.storedCredentials, "removed");
  await assert.rejects(() => readFile(tokenFile, "utf8"), /ENOENT/);

  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.outcome, "error");
  assert.equal(event.storedCredentials, "removed");
});

test("detects the logout flag", () => {
  assert.equal(isLogoutRequested(["--logout"]), true);
  assert.equal(isLogoutRequested([]), false);
  assert.equal(isLogoutRequested(["--healthcheck"]), false);
});

test("runLogout reports a completed logout and exits zero", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zendesk-logout-test-"));
  const tokenFile = join(directory, "oauth.json");
  await writeTokenFile(tokenFile, { access_token: "invented-access-token" });

  globalThis.fetch = recordingFetcher([]);

  const out: string[] = [];
  const err: string[] = [];
  const code = await runLogout({
    config: config({ tokenFile }),
    sink: () => undefined,
    writeOut: (line) => out.push(line),
    writeError: (line) => err.push(line),
  });

  assert.equal(code, 0);
  assert.equal(out.length, 1);
  assert.match(out[0], /logout complete/);
  assert.deepEqual(err, []);
});

test("runLogout reports an incomplete logout and exits one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zendesk-logout-test-"));
  const tokenFile = join(directory, "oauth.json");
  await writeTokenFile(tokenFile, { access_token: "invented-access-token" });

  globalThis.fetch = recordingFetcher([], () => {
    throw new Error("network unavailable");
  });

  const out: string[] = [];
  const err: string[] = [];
  const code = await runLogout({
    config: config({ tokenFile }),
    sink: () => undefined,
    writeOut: (line) => out.push(line),
    writeError: (line) => err.push(line),
  });

  assert.equal(code, 1);
  assert.equal(err.length, 1);
  assert.match(err[0], /logout incomplete/);
  assert.match(err[0], /network unavailable/);
  assert.deepEqual(out, []);
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

function config(overrides: Partial<ZendeskConfig> = {}): ZendeskConfig {
  return {
    baseUrl: "https://example.zendesk.com",
    mode: "authorization_code",
    clientId: "invented-client-id",
    clientSecret: "invented-client-secret",
    tokenFile: "/unused/oauth.json",
    scope: "read write",
    ...overrides,
  };
}
