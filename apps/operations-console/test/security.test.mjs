/**
 * The console's own defences: the Host header it answers to, the scope its
 * token asks for, and the account URL it is willing to post the client secret
 * to.
 *
 * Every value here is invented. Nothing in this suite reaches a live account
 * or the public internet.
 */
import assert from "node:assert/strict";
import { request } from "node:http";
import { connect } from "node:net";
import { after, afterEach, before, beforeEach, test } from "node:test";
import {
  getOAuthToken,
  isLoopbackHost,
  resetCaches,
  resolveConsoleBaseUrl,
  resolveConsoleScope,
} from "../server.mjs";
import { startMockZendesk } from "./helpers/mock-zendesk.mjs";
import {
  applyConsoleConfig,
  clientFileFor,
  getJson,
  makeTempDir,
  removeTempDir,
  startConsole,
  writeClientFile,
} from "./helpers/console.mjs";

const originalEnv = { ...process.env };

let mock;
let consoleServer;
let directory;

before(async () => {
  consoleServer = await startConsole();
  directory = await makeTempDir("operations-console-security-");
});

after(async () => {
  await consoleServer.close();
  await removeTempDir(directory);
});

beforeEach(async () => {
  resetCaches();
  applyConsoleConfig();
  // The scope and the account are resolved from the environment first, so a
  // value that happens to be exported on the host would decide what the
  // console asks for. The suite sets them itself.
  delete process.env.ZENDESK_OAUTH_SCOPE;
  delete process.env.ZENDESK_BASE_URL;
  delete process.env.ZENDESK_SUBDOMAIN;
  // Every test reads its own mock account, so the recording it asserts on
  // holds the requests of that test only.
  mock = await startMockZendesk();
});

afterEach(async () => {
  await mock?.close();
  process.env = { ...originalEnv };
});

test("answers a request that was addressed to the console itself", async () => {
  const { status, body } = await getJson(`${consoleServer.baseUrl}/api/status`);

  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

test("refuses a request that carries another host", async () => {
  // A page on another origin can reach a loopback server: DNS rebinding
  // resolves the attacker's name to 127.0.0.1, and the browser then treats
  // the answer as same-origin. The Host header is what tells the two apart.
  const response = await fetchWithHost(`${consoleServer.baseUrl}/api/status`, "attacker.example.com");

  assert.equal(response.status, 403);
  assert.deepEqual(response.body, { error: "Forbidden" });
});

test("refuses a request that carries no host at all", async () => {
  // An HTTP/1.0 client sends no Host header at all, so the request is written
  // by hand: Node's own client would add one.
  const response = await rawRequest(
    Number(new URL(consoleServer.baseUrl).port),
    "GET /api/status HTTP/1.0\r\n\r\n",
  );

  assert.equal(response.status, 403);
});

test("knows the loopback names it answers to", () => {
  assert.equal(isLoopbackHost("127.0.0.1:4177"), true);
  assert.equal(isLoopbackHost("localhost:4177"), true);
  assert.equal(isLoopbackHost("[::1]:4177"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("LOCALHOST:4177"), true);
  assert.equal(isLoopbackHost("attacker.example.com"), false);
  assert.equal(isLoopbackHost("127.0.0.1.attacker.example.com"), false);
  // A name that only starts like the console is not the console.
  assert.equal(isLoopbackHost("127.0.0.1:4177.attacker.example.com"), false);
  assert.equal(isLoopbackHost("localhost:4177@attacker.example.com"), false);
  assert.equal(isLoopbackHost("127.0.0.1:not-a-port"), false);
  assert.equal(isLoopbackHost(""), false);
  assert.equal(isLoopbackHost(undefined), false);
});

test("asks for the read scopes and no others", async () => {
  process.env.ZENDESK_OAUTH_CLIENT_FILE = await writeClientFile(
    directory,
    clientFileFor(mock.baseUrl),
  );

  await getOAuthToken();

  const [tokenRequest] = mock.state.tokenRequests;
  assert.equal(
    tokenRequest.body.scope,
    "tickets:read users:read organizations:read brands:read groups:read",
  );
});

test("drops the write scopes of the configured scope", async () => {
  process.env.ZENDESK_OAUTH_SCOPE = "tickets:read tickets:write users:read";

  assert.equal(resolveConsoleScope(), "tickets:read users:read");
});

test("reads the scope of the client file when the environment is silent", () => {
  assert.equal(
    resolveConsoleScope({ scope: "tickets:read organizations:read" }),
    "tickets:read organizations:read",
  );
});

test("falls back to the read scopes when nothing readable is configured", () => {
  assert.equal(
    resolveConsoleScope({ scope: "read write" }),
    "tickets:read users:read organizations:read brands:read groups:read",
  );
});

test("refuses an account URL that is not HTTPS", async () => {
  process.env.ZENDESK_OAUTH_CLIENT_FILE = await writeClientFile(directory, {
    baseUrl: "http://account.example.com",
    clientId: "invented-client-id",
    clientSecret: "invented-client-secret",
  });

  // The client secret must not leave the machine, so the request is watched
  // at the boundary instead of at the mock account: the refused URL names
  // another host, and the mock would never see it either way.
  const requested = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    requested.push(String(input));
    throw new Error("the console must not reach the account");
  };

  try {
    await assert.rejects(
      () => getOAuthToken(),
      /must use HTTPS/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requested, []);
  assert.deepEqual(mock.state.tokenRequests, []);
});

test("takes the account from the environment before the client file", async () => {
  process.env.ZENDESK_OAUTH_CLIENT_FILE = await writeClientFile(directory, {
    baseUrl: "https://file-account.zendesk.com",
    clientId: "invented-client-id",
    clientSecret: "invented-client-secret",
  });
  process.env.ZENDESK_BASE_URL = "https://example-account.zendesk.com";

  const requested = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    requested.push(String(input));
    return new Response(
      JSON.stringify({ access_token: "invented-access-token", expires_in: 3600 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const token = await getOAuthToken();
    assert.equal(token.baseUrl, "https://example-account.zendesk.com");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // The environment names the account, so the file's own URL is not used.
  assert.equal(requested.length, 1);
  assert.match(requested[0], /^https:\/\/example-account\.zendesk\.com\/oauth\/tokens$/);
});

test("names the account from the subdomain when no URL is configured", () => {
  process.env.ZENDESK_SUBDOMAIN = "example-account";

  assert.equal(
    resolveConsoleBaseUrl({}),
    "https://example-account.zendesk.com",
  );
});

test("names no account when nothing says which one", () => {
  assert.throws(
    () => resolveConsoleBaseUrl({}),
    /account is not configured/,
  );
});

test("accepts an IPv6 loopback account URL", () => {
  assert.equal(
    resolveConsoleBaseUrl({ baseUrl: "http://[::1]:8080" }),
    "http://[::1]:8080",
  );
});

test("allows a local account URL over plain HTTP", async () => {
  process.env.ZENDESK_OAUTH_CLIENT_FILE = await writeClientFile(
    directory,
    clientFileFor(mock.baseUrl),
  );

  const token = await getOAuthToken();

  assert.equal(token.baseUrl, mock.baseUrl);
});

/** Writes a request by hand and reads the status line of the answer. */
function rawRequest(port, requestText) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(requestText);
    });
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      resolve({ status: Number(raw.split(" ")[1]), raw });
    });
    socket.on("error", reject);
  });
}

/** Sends a request with the given Host header and reads the JSON answer. */
function fetchWithHost(url, host) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const headers = { Host: host };
    const call = request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "GET",
        headers,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode,
            body: raw === "" ? null : JSON.parse(raw),
          });
        });
      },
    );
    call.on("error", reject);
    call.end();
  });
}
