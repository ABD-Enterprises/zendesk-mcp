import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
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
  resolveTokenFile,
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

test("getConfig rejects an OAuth client file readable by other users", async (ctx) => {
  // Node reports synthetic permission bits on Windows (group and other always
  // look set), so the check is skipped there: this host cannot show the
  // refusal.
  if (process.platform === "win32") {
    ctx.skip("file mode bits are not reported the same way on Windows");
    return;
  }
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

test("getConfig rejects a client file whose baseUrl or subdomain is not a string", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zendesk-client-test-"));
  // resolveBaseUrl trims these values with String methods, so a JSON value of
  // the wrong type must be rejected where the file is read — as an
  // actionable configuration error, not a raw TypeError at startup.
  for (const [field, value] of [
    ["baseUrl", 123],
    ["subdomain", { name: "example" }],
  ] as const) {
    const clientFile = join(directory, `client-${field}.json`);
    await writeFile(clientFile, JSON.stringify({ [field]: value }), {
      mode: 0o600,
    });
    process.env = { ...originalEnv, ZENDESK_OAUTH_CLIENT_FILE: clientFile };
    delete process.env.ZENDESK_BASE_URL;
    delete process.env.ZENDESK_SUBDOMAIN;

    assert.throws(
      () => getConfig(),
      new RegExp(`has a "${field}" value that must be a string\\.`),
      `a wrong-typed ${field} must be reported by name`,
    );
  }
});

test("resolveTokenFile falls back to the client file's tokenFile field", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zendesk-client-test-"));
  const clientFile = join(directory, "client.json");
  const tokenFile = join(directory, "custom-oauth.json");
  // The configuration is unusable (no subdomain), so getConfig throws — but
  // the client file still names the token file, and a logout must clear that
  // path rather than the never-used default.
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
  process.env = { ...originalEnv, ZENDESK_OAUTH_CLIENT_FILE: clientFile };
  delete process.env.ZENDESK_SUBDOMAIN;
  delete process.env.ZENDESK_BASE_URL;
  delete process.env.ZENDESK_OAUTH_TOKEN_FILE;

  assert.equal(resolveTokenFile(), tokenFile);
});

test("resolveTokenFile skips a client path that is not a regular file", async (ctx) => {
  // A FIFO at the client path would block a bare readFileSync forever — and
  // a blocked synchronous call wedges its process, so no timer inside it
  // could turn the regression into a failure. The fallback therefore runs
  // in a child process with a timeout: removing the guard kills the child
  // and fails this test in seconds instead of hanging the whole run.
  // mkfifo is POSIX-only; without it this host cannot build the case.
  const directory = await mkdtemp(join(tmpdir(), "zendesk-fifo-test-"));
  const clientFile = join(directory, "client.json");
  try {
    execFileSync("mkfifo", [clientFile]);
  } catch (error) {
    // Only "no mkfifo on this host" may skip; any other failure is the host
    // acting up and must surface, not silently shrink coverage.
    if ((error as { code?: string }).code === "ENOENT") {
      ctx.skip("mkfifo is unavailable on this host");
      return;
    }
    throw error;
  }
  const home = join(directory, "home");
  const childEnv: NodeJS.ProcessEnv = {
    ...originalEnv,
    HOME: home,
    USERPROFILE: home,
    ZENDESK_OAUTH_CLIENT_FILE: clientFile,
  };
  delete childEnv.ZENDESK_OAUTH_TOKEN_FILE;
  delete childEnv.ZENDESK_SUBDOMAIN;
  delete childEnv.ZENDESK_BASE_URL;

  const script =
    `import { resolveTokenFile } from ${JSON.stringify(
      new URL("./auth.js", import.meta.url).href,
    )};` + "process.stdout.write(resolveTokenFile());";
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { encoding: "utf8", env: childEnv, timeout: 15_000 },
  );

  // The fallback lands at the default path under the child's HOME — the
  // real home is never named, let alone touched. (Computed from `home`
  // directly: an earlier test replaces process.env with a plain object, so
  // the parent's defaultTokenFile() no longer reflects the child's HOME.)
  assert.equal(output, join(home, ".config", "codex-zendesk", "oauth.json"));
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

test("writeTokenFile writes the token through no link", async (t) => {
  // Creating a link needs a privilege Windows does not grant by default.
  if (process.platform === "win32") {
    t.skip("symlinks need a privilege this host does not grant");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "zendesk-token-link-test-"));
  const tokenFile = join(directory, "oauth.json");
  const captured = join(directory, "captured.json");
  await writeFile(captured, "");
  // A link at the token file's own path would be written through by a plain
  // write, and a link at the temporary path would be written through by a
  // write that follows it. The temporary name carries random bytes, so no
  // local user can guess where the token lands on its way there.
  await symlink(captured, tokenFile);
  await symlink(captured, `${tokenFile}.${process.pid}.tmp`);

  await writeTokenFile(tokenFile, { access_token: "invented-access-token" });

  // The links were replaced, not followed: the file they pointed at still
  // holds nothing, and the token file holds the token.
  assert.equal(await readFile(captured, "utf8"), "");
  const written = JSON.parse(await readFile(tokenFile, "utf8"));
  assert.equal(written.access_token, "invented-access-token");
});

test("writeTokenFile writes twice in a row", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zendesk-token-stale-test-"));
  const tokenFile = join(directory, "oauth.json");

  await writeTokenFile(tokenFile, { access_token: "invented-access-token" });
  await writeTokenFile(tokenFile, { access_token: "invented-second-token" });

  // Neither write may trip over the other's temporary file.
  const written = JSON.parse(await readFile(tokenFile, "utf8"));
  assert.equal(written.access_token, "invented-second-token");
});

test("writeTokenFile refuses a shared token directory", async (t) => {
  // Node reports synthetic permission bits on Windows, so the check is skipped
  // there instead of failing every run.
  if (process.platform === "win32") {
    t.skip("file mode bits are not reported the same way on Windows");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "zendesk-token-dir-test-"));
  // mkdir's mode applies only to a directory it creates, so an existing one
  // keeps its own permissions.
  await chmod(directory, 0o777);

  // Another local user could replace the token file in a directory they can
  // write to, so the write is refused rather than the directory tightened:
  // the directory may be one the operator shares, and changing its
  // permissions behind their back is not the connector's call.
  await assert.rejects(
    () => writeTokenFile(join(directory, "oauth.json"), {
      access_token: "invented-access-token",
    }),
    /writable by other users/,
  );
  assert.equal((await stat(directory)).mode & 0o777, 0o777);
});

test("the tool status omits the token file's path", () => {
  const auth = new ZendeskOAuth({
    baseUrl: "https://example.zendesk.com",
    mode: "authorization_code",
    clientId: "invented-client-id",
    clientSecret: "invented-client-secret",
    tokenFile: "/unused/oauth.json",
    scope: "tickets:read",
  });

  // The operator still gets the path from the doctor and the logout.
  assert.equal(auth.status().tokenFile, "/unused/oauth.json");
  assert.equal("tokenFile" in auth.toolStatus(), false);
  assert.equal(auth.toolStatus().mode, "authorization_code");
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

test("a refused token exchange reports a shape summary and no body values", async () => {
  const echoedSecret = "invented-client-secret-value";
  const oauth = new ZendeskOAuth(
    config({
      mode: "client_credentials",
      clientSecret: echoedSecret,
    }),
    async () =>
      new Response(
        JSON.stringify({
          error: "invalid_client",
          error_description: `client_secret ${echoedSecret} rejected`,
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        },
      ),
  );

  await assert.rejects(
    () => oauth.getAccessToken(true),
    (error: unknown) => {
      assert.ok(error instanceof ZendeskAuthError);
      assert.equal(error.status, 401);
      const details = error.details as Record<string, unknown>;
      assert.equal(details.mediaType, "application/json");
      assert.equal(typeof details.bytes, "number");
      assert.deepEqual(details.keys, ["error", "error_description"]);
      assert.equal(details.error, "invalid_client");
      // The body carried a credential in a value; the summary must not.
      assert.ok(!JSON.stringify(details).includes(echoedSecret));
      return true;
    },
  );
});

test("a token response without an access token reports no body values", async () => {
  const leakedToken = "invented-refresh-token-value";
  const oauth = new ZendeskOAuth(
    config({ mode: "client_credentials" }),
    async () =>
      new Response(
        JSON.stringify({ refresh_token: leakedToken, token_type: "bearer" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );

  await assert.rejects(
    () => oauth.getAccessToken(true),
    (error: unknown) => {
      assert.ok(error instanceof ZendeskAuthError);
      const details = error.details as Record<string, unknown>;
      assert.deepEqual(details.keys, ["refresh_token", "token_type"]);
      assert.ok(!JSON.stringify(details).includes(leakedToken));
      return true;
    },
  );
});

test("a token error body that is not JSON is described by media type and size", async () => {
  const oauth = new ZendeskOAuth(
    config({ mode: "client_credentials" }),
    async () =>
      new Response("invented-plain-text-credential", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      }),
  );

  await assert.rejects(
    () => oauth.getAccessToken(true),
    (error: unknown) => {
      assert.ok(error instanceof ZendeskAuthError);
      const details = error.details as Record<string, unknown>;
      assert.equal(details.mediaType, "text/plain");
      assert.equal(details.bytes, "invented-plain-text-credential".length);
      assert.equal(details.keys, undefined);
      assert.ok(!JSON.stringify(details).includes("invented-plain-text-credential"));
      return true;
    },
  );
});

test("a token error body without a content type is described as unknown", async () => {
  const oauth = new ZendeskOAuth(
    config({ mode: "client_credentials" }),
    async () =>
      // A byte body carries no content type of its own.
      new Response(new Uint8Array([104, 105]), { status: 500 }),
  );

  await assert.rejects(
    () => oauth.getAccessToken(true),
    (error: unknown) => {
      assert.ok(error instanceof ZendeskAuthError);
      const details = error.details as Record<string, unknown>;
      assert.equal(details.mediaType, "unknown");
      assert.equal(details.bytes, 2);
      assert.equal(details.keys, undefined);
      assert.ok(!JSON.stringify(details).includes("hi"));
      return true;
    },
  );
});

test("a credential parked in a field name is masked in the summary", async () => {
  const oauth = new ZendeskOAuth(
    config({ mode: "client_credentials" }),
    async () =>
      new Response(
        JSON.stringify({ "sk_live_invented999": "value", error: "invalid_client" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
  );

  await assert.rejects(
    () => oauth.getAccessToken(true),
    (error: unknown) => {
      assert.ok(error instanceof ZendeskAuthError);
      const details = error.details as Record<string, unknown>;
      assert.deepEqual(details.keys, ["[REDACTED]", "error"]);
      assert.ok(!JSON.stringify(details).includes("sk_live_invented999"));
      return true;
    },
  );
});

test("a field name outside the token response vocabulary is masked", async () => {
  for (const name of ["sk_live_abc12", "abcdefghijklmnopqrstuvwx"]) {
    const oauth = new ZendeskOAuth(
      config({ mode: "client_credentials" }),
      async () =>
        new Response(JSON.stringify({ [name]: "value" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await assert.rejects(
      () => oauth.getAccessToken(true),
      (error: unknown) => {
        assert.ok(error instanceof ZendeskAuthError);
        const details = error.details as Record<string, unknown>;
        assert.deepEqual(details.keys, ["[REDACTED]"]);
        assert.ok(!JSON.stringify(details).includes(name));
        return true;
      },
    );
  }
});

test("an error code outside the OAuth vocabulary is dropped", async () => {
  for (const code of ["sk_live_abc123", "abcdefghijklmnopqrstuvwx", "SomeVendorError"]) {
    const oauth = new ZendeskOAuth(
      config({ mode: "client_credentials" }),
      async () =>
        new Response(JSON.stringify({ error: code }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await assert.rejects(
      () => oauth.getAccessToken(true),
      (error: unknown) => {
        assert.ok(error instanceof ZendeskAuthError);
        const details = error.details as Record<string, unknown>;
        // The code is not a registered OAuth error, so it is not carried.
        assert.equal(details.error, undefined);
        assert.ok(!JSON.stringify(details).includes(code));
        return true;
      },
    );
  }
});

test("a registered OAuth error code is kept", async () => {
  const oauth = new ZendeskOAuth(
    config({ mode: "client_credentials" }),
    async () =>
      new Response(JSON.stringify({ error: "invalid_scope" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
  );

  await assert.rejects(
    () => oauth.getAccessToken(true),
    (error: unknown) => {
      assert.ok(error instanceof ZendeskAuthError);
      const details = error.details as Record<string, unknown>;
      assert.equal(details.error, "invalid_scope");
      return true;
    },
  );
});