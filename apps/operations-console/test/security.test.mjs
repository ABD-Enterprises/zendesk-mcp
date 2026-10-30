/**
 * The console's own defences: the Host header it answers to, the scope its
 * token asks for, the account URL it is willing to post the client secret to,
 * the redirect it refuses to follow, and the failure detail it keeps out of
 * the browser.
 *
 * Every value here is invented. Nothing in this suite reaches a live account
 * or the public internet.
 */
import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { connect } from "node:net";
import { after, afterEach, before, beforeEach, test } from "node:test";
import {
  allowedHosts,
  app,
  getOAuthToken,
  isAllowedHost,
  isLoopbackHost,
  mountStaticFiles,
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
  clearAccountEnv,
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
  clearAccountEnv();
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

test("answers a host the operator allowed for a proxy in front of it", async () => {
  // A proxy forwards the name the browser asked for, not the loopback
  // address, so a console behind a proxy needs that name on its list.
  process.env.ZENDESK_CONSOLE_ALLOWED_HOSTS = "console.example.com";

  const response = await fetchWithHost(
    `${consoleServer.baseUrl}/api/status`,
    "console.example.com",
  );

  assert.equal(response.status, 200);
});

test("refuses an allowed host that carries another port", async () => {
  // The name is matched against the whole Host header. A browser that
  // reaches the console's own port sends "name:port", which is not the
  // header the operator listed, so a rebound name stays out.
  process.env.ZENDESK_CONSOLE_ALLOWED_HOSTS = "console.example.com";

  const response = await fetchWithHost(
    `${consoleServer.baseUrl}/api/status`,
    "console.example.com:4177",
  );

  assert.equal(response.status, 403);
});

test("refuses a host that the operator did not allow", async () => {
  process.env.ZENDESK_CONSOLE_ALLOWED_HOSTS = "console.example.com";

  const response = await fetchWithHost(
    `${consoleServer.baseUrl}/api/status`,
    "other.example.com",
  );

  assert.equal(response.status, 403);
});

test("answers no other host when the list is empty", async () => {
  // The list is empty unless the operator fills it in.
  assert.deepEqual(allowedHosts(), []);

  const response = await fetchWithHost(
    `${consoleServer.baseUrl}/api/status`,
    "console.example.com",
  );

  assert.equal(response.status, 403);
});

test("reads the allowed hosts from the environment", () => {
  process.env.ZENDESK_CONSOLE_ALLOWED_HOSTS = "Console.Example.com, other.example.com";

  assert.deepEqual(allowedHosts(), ["console.example.com", "other.example.com"]);
});

test("asks for the scope the console reads and no others", async () => {
  process.env.ZENDESK_OAUTH_CLIENT_FILE = await writeClientFile(
    directory,
    clientFileFor(mock.baseUrl),
  );

  await getOAuthToken();

  const [tokenRequest] = mock.state.tokenRequests;
  // The console reads two ticket views. `ticket_views:read` is documented as
  // "view ticket views and the tickets they return", and `tickets:read`
  // covers the ticket fields the dashboard reads off the rows.
  assert.equal(tokenRequest.body.scope, "ticket_views:read tickets:read");
});

test("drops the write scopes of the configured scope", () => {
  process.env.ZENDESK_OAUTH_SCOPE =
    "ticket_views:read tickets:read tickets:write users:read";

  assert.equal(
    resolveConsoleScope(),
    "ticket_views:read tickets:read users:read",
  );
});

test("takes the scope of the console's own setting first", () => {
  process.env.ZENDESK_OAUTH_SCOPE = "ticket_views:read tickets:read";
  process.env.ZENDESK_CONSOLE_OAUTH_SCOPE = "ticket_views:read tickets:read";

  assert.equal(resolveConsoleScope(), "ticket_views:read tickets:read");
});

test("does not take the scope of the client file", async () => {
  // The client file holds the connector's scope: it names what the connector
  // reads and it carries write scopes. The console reads different things and
  // writes none, so it asks for its own.
  process.env.ZENDESK_OAUTH_CLIENT_FILE = await writeClientFile(directory, {
    ...clientFileFor(mock.baseUrl),
    scope: "tickets:read tickets:write",
  });

  await getOAuthToken();

  const [tokenRequest] = mock.state.tokenRequests;
  assert.equal(tokenRequest.body.scope, "ticket_views:read tickets:read");
});

test("never asks for a scope the operator did not name", () => {
  // Zendesk caps what a client may request at the scopes allowed on the
  // OAuth client and answers a request outside that set with
  // `400 invalid_scope`, so the console does not add a scope of its own.
  process.env.ZENDESK_OAUTH_SCOPE = "ticket_views:read tickets:read";

  assert.equal(resolveConsoleScope(), "ticket_views:read tickets:read");
});

test("names both scopes when neither of them can be granted", () => {
  process.env.ZENDESK_OAUTH_SCOPE = "tickets:write";

  assert.throws(
    () => resolveConsoleScope(),
    (error) =>
      error.message ===
      "The console reads ticket views and the ticket fields on them, so its token needs the ticket_views:read and tickets:read scopes. " +
        "Add them to ZENDESK_CONSOLE_OAUTH_SCOPE (or to ZENDESK_OAUTH_SCOPE) and allow them on the Zendesk OAuth client.",
  );
});

test("names the scope it needs when the configured scope cannot read a ticket's fields", () => {
  // The dashboard reads the request type and the system off the rows a view
  // returns. A scope that cannot read them would leave every ticket
  // "Unclassified", so the console says what is missing instead of running
  // with a dashboard that is quietly wrong.
  process.env.ZENDESK_OAUTH_SCOPE = "ticket_views:read";

  assert.throws(
    () => resolveConsoleScope(),
    /tickets:read/,
  );
});

test("names the scope it needs when the configured scope cannot read a view", () => {
  process.env.ZENDESK_OAUTH_SCOPE = "tickets:read tickets:write";

  assert.throws(
    () => resolveConsoleScope(),
    (error) =>
      error.message ===
      "The console reads ticket views and the ticket fields on them, so its token needs the ticket_views:read scope. " +
        "Add it to ZENDESK_CONSOLE_OAUTH_SCOPE (or to ZENDESK_OAUTH_SCOPE) and allow it on the Zendesk OAuth client.",
  );
});
test("names the scope it needs when nothing readable is configured", () => {
  process.env.ZENDESK_OAUTH_SCOPE = "tickets:write";

  assert.throws(
    () => resolveConsoleScope(),
    /ticket_views:read/,
  );
});

test("accepts the broad read scope", () => {
  // `read` is a read scope: it covers every GET endpoint, a view included.
  process.env.ZENDESK_OAUTH_SCOPE = "read write";

  assert.equal(resolveConsoleScope(), "read");
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

test("takes the account from the client file, not from the environment", async () => {
  process.env.ZENDESK_OAUTH_CLIENT_FILE = await writeClientFile(directory, {
    baseUrl: "https://file-account.zendesk.com",
    clientId: "invented-client-id",
    clientSecret: "invented-client-secret",
  });
  // An exported account variable names an account for the connector. The
  // console does not follow it: the client secret would go to that account.
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
    assert.equal(token.baseUrl, "https://file-account.zendesk.com");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requested.length, 1);
  assert.match(requested[0], /^https:\/\/file-account\.zendesk\.com\/oauth\/tokens$/);
});

test("names the account from the subdomain of the client file", () => {
  assert.equal(
    resolveConsoleBaseUrl({ subdomain: "example-account" }),
    "https://example-account.zendesk.com",
  );
});

test("names no account when the client file names none", () => {
  assert.throws(
    () => resolveConsoleBaseUrl({}),
    /does not name an account/,
  );
});

test("ignores an exported account variable", () => {
  process.env.ZENDESK_SUBDOMAIN = "example-account";

  assert.throws(
    () => resolveConsoleBaseUrl({}),
    /does not name an account/,
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

test("does not follow a redirect that would carry the client secret", async () => {
  const target = await startRecordingServer();
  const account = await startRedirectingAccount(target.baseUrl);
  try {
    process.env.ZENDESK_OAUTH_CLIENT_FILE = await writeClientFile(
      directory,
      clientFileFor(account.baseUrl),
    );

    await assert.rejects(getOAuthToken(), /redirect/i);

    // The account was validated, so a redirect must not take the secret to a
    // host the console never looked at.
    assert.deepEqual(target.state.requests, []);
  } finally {
    await account.close();
    await target.close();
  }
});

test("keeps an upstream failure detail out of the browser", async () => {
  const account = await startBrokenAccount();
  try {
    process.env.ZENDESK_OAUTH_CLIENT_FILE = await writeClientFile(
      directory,
      clientFileFor(account.baseUrl),
    );

    const { status, body } = await getJson(`${consoleServer.baseUrl}/api/overview`);

    assert.equal(status, 503);
    // The browser gets the console's own message. The upstream detail quotes
    // the response the console could not read, so it stays in the log.
    assert.equal(body.error, "Zendesk is unavailable");
    assert.ok(
      !JSON.stringify(body).includes("invented-client-secret"),
      `the browser must not see the upstream detail: ${JSON.stringify(body)}`,
    );
  } finally {
    await account.close();
  }
});

test("refuses a client file that another user can read", async () => {
  // The file holds the client secret, and the console posts it to the
  // account the file names, so it has to be one only its owner can read.
  const file = join(directory, "loose-client.json");
  await writeFile(
    file,
    JSON.stringify(clientFileFor(mock.baseUrl)),
    { mode: 0o644 },
  );
  await chmod(file, 0o644);
  process.env.ZENDESK_OAUTH_CLIENT_FILE = file;

  await assert.rejects(getOAuthToken(), /readable only by its owner/i);

  // The secret never left the machine.
  assert.deepEqual(mock.state.tokenRequests, []);
});

test("shows the OAuth error code only when it is a known one", async () => {
  const account = await startRefusingAccount("invalid_scope");
  try {
    process.env.ZENDESK_OAUTH_CLIENT_FILE = await writeClientFile(
      directory,
      clientFileFor(account.baseUrl),
    );

    const { status, body } = await getJson(`${consoleServer.baseUrl}/api/overview`);

    assert.equal(status, 503);
    // The code is what tells the operator that the client was not granted
    // the scopes the console asks for, and the message names the scope.
    assert.equal(
      body.error,
      "Zendesk OAuth failed (400 invalid_scope). The console's token needs the ticket_views:read and tickets:read scopes: allow them on the Zendesk OAuth client.",
    );
  } finally {
    await account.close();
  }
});

test("names the scope the console asked for when the account refuses it", async () => {
  // The advice names the scope the console asked for, not the scope it
  // requires: an operator who asked for the broad read scope is told to
  // allow read, and telling them to allow two granular scopes would not have
  // helped.
  const account = await startRefusingAccount("invalid_scope");
  try {
    process.env.ZENDESK_OAUTH_SCOPE = "read";
    process.env.ZENDESK_OAUTH_CLIENT_FILE = await writeClientFile(
      directory,
      clientFileFor(account.baseUrl),
    );

    const { status, body } = await getJson(`${consoleServer.baseUrl}/api/overview`);

    assert.equal(status, 503);
    assert.equal(
      body.error,
      "Zendesk OAuth failed (400 invalid_scope). The console's token needs the read scope: allow it on the Zendesk OAuth client.",
    );
  } finally {
    await account.close();
  }
});

test("does not show an error code the console did not write", async () => {
  const account = await startRefusingAccount("sk_not_a_code_the_console_knows");
  try {
    process.env.ZENDESK_OAUTH_CLIENT_FILE = await writeClientFile(
      directory,
      clientFileFor(account.baseUrl),
    );

    const { status, body } = await getJson(`${consoleServer.baseUrl}/api/overview`);

    assert.equal(status, 503);
    // The body of a refused request is written by the account, so a value
    // outside the fixed vocabulary of OAuth error codes is not shown.
    assert.equal(body.error, "Zendesk OAuth failed (400)");
    assert.ok(
      !JSON.stringify(body).includes("sk_not_a_code"),
      `the browser must not see the upstream value: ${JSON.stringify(body)}`,
    );
  } finally {
    await account.close();
  }
});

test("does not follow a redirect that would carry the access token", async () => {
  const target = await startRecordingServer();
  const account = await startRedirectingViews(target.baseUrl);
  try {
    process.env.ZENDESK_OAUTH_CLIENT_FILE = await writeClientFile(
      directory,
      clientFileFor(account.baseUrl),
    );

    // The token request is answered normally; only the view request
    // redirects, so the token is what a redirect would carry away.
    const { status } = await getJson(`${consoleServer.baseUrl}/api/overview`);

    assert.equal(status, 503);
    assert.deepEqual(target.state.requests, []);
  } finally {
    await account.close();
    await target.close();
  }
});

test("refuses a request for a file that carries another host", async () => {
  // The Host check runs before every route, the file routes included: a
  // request for the frontend is refused the same way a request for an API
  // route is. The file routes are mounted on the console app here, so the
  // order the app answers in is the order the server answers in.
  const directory = await makeTempDir("operations-console-static-");
  const stack = app.router.stack;
  const mounted = stack.length;
  try {
    await writeFile(
      join(directory, "index.html"),
      "<!doctype html><title>Console</title>",
    );
    mountStaticFiles(app, { distDir: directory });

    for (const path of ["/", "/index.html", "/some/spa/route"]) {
      const refused = await fetchWithHost(
        `${consoleServer.baseUrl}${path}`,
        "attacker.example.com",
      );
      assert.equal(refused.status, 403, `${path} should be refused`);
      assert.deepEqual(refused.body, { error: "Forbidden" });

      // The console itself is answered, so the refusal above was the Host
      // check and not a route that does not exist.
      const answered = await fetch(`${consoleServer.baseUrl}${path}`);
      assert.equal(answered.status, 200, `${path} should be answered`);
    }
  } finally {
    // The file routes stay off the app afterwards, so the next test in this
    // file finds it as it was.
    stack.length = mounted;
    await removeTempDir(directory);
  }

  // The restore is what the next test in this file relies on, so it is
  // checked: the app carries the routes it carried before.
  assert.equal(app.router.stack.length, mounted);
});

test("matches a Host against a list and nothing else", () => {
  // The list has to be a list. A string would turn the whole-header match
  // into a substring match, which is the opposite of what the check is for.
  assert.equal(isAllowedHost("console.example.com", ["console.example.com"]), true);
  assert.equal(isAllowedHost("console.example.com", "console.example.com"), false);
  assert.equal(isAllowedHost("console.example.com", []), false);
  // The loopback names are the console's own, with or without a list.
  assert.equal(isAllowedHost("127.0.0.1:4177", "not-a-list"), true);
});

/** A server that records every request it receives. */
async function startRecordingServer() {
  const state = { requests: [] };
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      state.requests.push({
        method: request.method,
        url: request.url,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ access_token: "invented-access-token" }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

/** An account that answers every request with a redirect to another host. */
async function startRedirectingAccount(target) {
  const server = createServer((request, response) => {
    response.writeHead(307, { Location: `${target}/oauth/tokens` });
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
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

/** An account that refuses the token request with the given OAuth error. */
async function startRefusingAccount(code) {
  const server = createServer((request, response) => {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: code }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
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

/**
 * An account that hands out a token but redirects every other request, so a
 * redirect would carry the access token away.
 */
async function startRedirectingViews(target) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/oauth/tokens") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ access_token: "invented-access-token", expires_in: 3600 }),
      );
      return;
    }
    response.writeHead(307, { Location: `${target}/views` });
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
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

/**
 * An account that hands out a token but answers the view with a body that is
 * not JSON, so the console's parse error quotes the body it could not read.
 */
async function startBrokenAccount() {  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/oauth/tokens") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ access_token: "invented-access-token", expires_in: 3600 }),
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("invented-client-secret is not json");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
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
