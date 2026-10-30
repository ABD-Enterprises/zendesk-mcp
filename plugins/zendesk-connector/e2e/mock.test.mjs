/**
 * Hermetic end-to-end suite: drives `e2e/run-e2e.mjs` against the built
 * server with a local `node:http` mock Zendesk. No account, no live network
 * access, and no real credential anywhere — every value is invented,
 * `example`-style data, and token values are never printed.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const harnessPath = join(here, "run-e2e.mjs");
const serverBuildPath = join(here, "..", "dist", "index.js");

// The watchdog sits strictly above the harness's own overall deadline
// (120 s) plus its shutdown grace (5 s), so the harness's deadline is what
// fires and its cleanup runs; the watchdog only catches a fully hung run.
const HARNESS_DEADLINE_MS = 120_000;
const SHUTDOWN_GRACE_MS = 5_000;
const WATCHDOG_MS = HARNESS_DEADLINE_MS + SHUTDOWN_GRACE_MS + 30_000;

// An invented dummy token: asserted in place, never printed.
const DUMMY_TOKEN = "example-e2e-dummy-token";

const EXERCISED_TOOLS = [
  "zendesk_status",
  "zendesk_list_brands",
  "zendesk_list_groups",
  "zendesk_list_users",
  "zendesk_list_organizations",
  "zendesk_list_ticket_fields",
  "zendesk_list_ticket_forms",
  "zendesk_search_tickets",
  "zendesk_get_ticket",
];

// The exact set of endpoints the harness is expected to fetch, keyed by
// pathname; compared as a set so no assertion depends on hand-written sort
// order (and so default page/per_page query parameters cannot break it).
const EXPECTED_REQUESTS = [
  "GET /api/v2/brands.json",
  "GET /api/v2/groups.json",
  "GET /api/v2/organizations.json",
  "GET /api/v2/search.json",
  "GET /api/v2/ticket_fields.json",
  "GET /api/v2/ticket_forms.json",
  "GET /api/v2/tickets/601.json",
  "GET /api/v2/tickets/601/comments.json",
  "GET /api/v2/users.json",
  "GET /api/v2/users/me.json",
];

test("harness runs the read-only tools against a local mock Zendesk", async (t) => {
  assert.ok(
    existsSync(serverBuildPath),
    `built server not found at ${serverBuildPath} — run \`npm run build\` from plugins/zendesk-connector first`,
  );

  const mock = await startMockZendesk();
  const hostTemp = await mkdtemp(join(tmpdir(), "zendesk-mcp-e2e-decoy-"));
  t.after(async () => {
    await closeMock(mock);
    await rm(hostTemp, { recursive: true, force: true });
  });

  const run = await runHarness({
    extraEnv: {
      ZENDESK_BASE_URL: `http://127.0.0.1:${mock.port}`,
      ZENDESK_OAUTH_ACCESS_TOKEN: DUMMY_TOKEN,
      // Decoys that do not exist: if the harness failed to overwrite the
      // OAuth file paths, the child server would fail to start.
      ZENDESK_OAUTH_CLIENT_FILE: join(hostTemp, "ambient-client.json"),
      ZENDESK_OAUTH_TOKEN_FILE: join(hostTemp, "ambient-oauth.json"),
      ZENDESK_E2E_TICKET_ID: "601",
    },
    removeNames: ["ZENDESK_SUBDOMAIN"],
  });

  assert.equal(
    run.exit,
    0,
    `harness should pass\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
  );

  // Every exercised tool passed. A PASS line is only printed after the
  // harness verified the payload contents, so this covers both the tool
  // results and their key fields (ticket id 601, non-empty records).
  for (const tool of EXERCISED_TOOLS) {
    assert.match(run.stdout, new RegExp(`^harness: PASS ${tool}$`, "m"));
  }
  assert.match(run.stdout, /^harness: 9 passed, 0 failed$/m);

  // The harness fetched exactly the expected endpoints, as a set.
  assert.deepEqual(new Set(mock.state.requests), new Set(EXPECTED_REQUESTS));
  // The order is meaningful where it matters: ticket before its comments.
  assert.ok(
    mock.state.requests.indexOf("GET /api/v2/tickets/601.json") <
      mock.state.requests.indexOf("GET /api/v2/tickets/601/comments.json"),
    `expected ticket before comments, received ${JSON.stringify(mock.state.requests)}`,
  );
  // The search request carried the harness's query, not a bare path.
  const searchUrl = mock.state.fullUrls.find((url) =>
    url.startsWith("/api/v2/search.json"),
  );
  assert.ok(searchUrl, "the harness never called the search endpoint");
  assert.ok(
    searchUrl.includes("query=type%3Aticket"),
    `expected the search query in ${searchUrl}`,
  );

  // Every request carried the dummy bearer token — and it was never logged.
  assert.deepEqual(
    new Set(mock.state.authorization),
    new Set([`Bearer ${DUMMY_TOKEN}`]),
  );
  assert.ok(
    !run.stdout.includes(DUMMY_TOKEN) && !run.stderr.includes(DUMMY_TOKEN),
    "the harness must never print the token value",
  );

  // The harness relocated the OAuth files into its own temp directory and
  // removed it again on the way out.
  const tempMatch = run.stdout.match(/^harness: temporary OAuth files in (.+)$/m);
  assert.ok(tempMatch, `missing temp-directory notice\nstdout:\n${run.stdout}`);
  assert.equal(existsSync(tempMatch[1]), false, "the harness temp directory must be cleaned up");
});

test("harness fails when a list tool returns empty records", async (t) => {
  assert.ok(
    existsSync(serverBuildPath),
    `built server not found at ${serverBuildPath} — run \`npm run build\` from plugins/zendesk-connector first`,
  );

  // A regression that returns empty or mis-keyed records must not pass:
  // the mock serves an empty brands list and the harness has to fail.
  const mock = await startMockZendesk({
    "GET /api/v2/brands.json": () => ({
      count: 0,
      next_page: null,
      brands: [],
    }),
  });
  t.after(() => closeMock(mock));

  const run = await runHarness({
    extraEnv: {
      ZENDESK_BASE_URL: `http://127.0.0.1:${mock.port}`,
      ZENDESK_OAUTH_ACCESS_TOKEN: DUMMY_TOKEN,
    },
    removeNames: ["ZENDESK_SUBDOMAIN", "ZENDESK_E2E_TICKET_ID"],
  });

  assert.notEqual(run.exit, 0, `harness should fail\nstdout:\n${run.stdout}`);
  assert.match(run.stdout, /^harness: FAIL zendesk_list_brands: .*brands.*$/m);
});

test("harness skips cleanly when the sandbox is unconfigured", async (t) => {
  const cleared = [
    "ZENDESK_BASE_URL",
    "ZENDESK_SUBDOMAIN",
    "ZENDESK_OAUTH_ACCESS_TOKEN",
    "ZENDESK_E2E_TICKET_ID",
  ];

  // No connectivity at all: skip with exit 0.
  const unconfigured = await runHarness({ removeNames: cleared });
  assert.equal(unconfigured.exit, 0, `stdout:\n${unconfigured.stdout}`);
  assert.match(unconfigured.stdout, /SKIP end-to-end run/);

  // A base URL without a token is also a skip, not a failure.
  const tokenless = await runHarness({
    extraEnv: { ZENDESK_BASE_URL: "http://127.0.0.1:9" },
    removeNames: ["ZENDESK_SUBDOMAIN", "ZENDESK_OAUTH_ACCESS_TOKEN", "ZENDESK_E2E_TICKET_ID"],
  });
  assert.equal(tokenless.exit, 0, `stdout:\n${tokenless.stdout}`);
  assert.match(tokenless.stdout, /SKIP end-to-end run/);
});

/** Spawns the harness and resolves with its exit state and output. */
function runHarness({ extraEnv = {}, removeNames = [] } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const name of removeNames) delete env[name];
    // An ambient allowlist or read-only flag would hide tools
    // nondeterministically; the suite exercises the default full read
    // surface.
    delete env.ZENDESK_ALLOWED_TOOLS;
    delete env.ZENDESK_READ_ONLY;
    Object.assign(env, extraEnv);

    const child = spawn(process.execPath, [harnessPath], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const watchdog = setTimeout(() => {
      child.kill("SIGKILL");
    }, WATCHDOG_MS);
    watchdog.unref();

    child.once("error", (error) => {
      clearTimeout(watchdog);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(watchdog);
      resolve({ exit: code, signal, stdout, stderr });
    });
  });
}

/**
 * Starts a local mock Zendesk implementing exactly the endpoints the
 * harness's read-only tool sequence touches. `overrides` replaces individual
 * `METHOD /path` route payloads for negative cases.
 */
async function startMockZendesk(overrides = {}) {
  const routes = {
    "GET /api/v2/users/me.json": () => ({
      user: { id: 7001, name: "Example Agent", email: "agent@example.test" },
    }),
    "GET /api/v2/brands.json": () => ({
      count: 1,
      next_page: null,
      brands: [{ id: 501, name: "Example Brand", subdomain: "example" }],
    }),
    "GET /api/v2/groups.json": () => ({
      count: 1,
      next_page: null,
      groups: [{ id: 502, name: "Example Support Group" }],
    }),
    "GET /api/v2/users.json": () => ({
      count: 2,
      next_page: null,
      users: [
        { id: 7001, name: "Example Agent", email: "agent@example.test" },
        { id: 7002, name: "Example Requester", email: "requester@example.test" },
      ],
    }),
    "GET /api/v2/organizations.json": () => ({
      count: 1,
      next_page: null,
      organizations: [{ id: 503, name: "Example Org" }],
    }),
    "GET /api/v2/ticket_fields.json": () => ({
      ticket_fields: [
        { id: 1, title: "Subject", type: "subject" },
        { id: 4, title: "Description", type: "textarea" },
      ],
    }),
    "GET /api/v2/ticket_forms.json": () => ({
      count: 1,
      next_page: null,
      ticket_forms: [{ id: 1, name: "Example default form" }],
    }),
    "GET /api/v2/search.json": () => ({
      count: 1,
      next_page: null,
      results: [
        {
          id: 601,
          result_type: "ticket",
          subject: "Example ticket",
          status: "open",
        },
      ],
    }),
    "GET /api/v2/tickets/601.json": () => ({
      ticket: {
        id: 601,
        subject: "Example ticket",
        status: "open",
        priority: "normal",
      },
      users: [{ id: 7002, name: "Example Requester" }],
      organizations: [{ id: 503, name: "Example Org" }],
    }),
    "GET /api/v2/tickets/601/comments.json": () => ({
      comments: [
        { id: 9001, body: "Example initial comment", author_id: 7001 },
      ],
      users: [{ id: 7001, name: "Example Agent" }],
      next_page: null,
    }),
    ...overrides,
  };

  const state = { requests: [], fullUrls: [], authorization: [] };
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    state.requests.push(`${request.method} ${url.pathname}`);
    state.fullUrls.push(url.pathname + url.search);
    state.authorization.push(request.headers.authorization);

    const route = routes[`${request.method} ${url.pathname}`];
    if (!route) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "no mock route" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(route()));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, state, port: server.address().port };
}

function closeMock(mock) {
  return new Promise((resolve) => {
    mock.server.close(() => resolve());
    mock.server.closeAllConnections?.();
  });
}
