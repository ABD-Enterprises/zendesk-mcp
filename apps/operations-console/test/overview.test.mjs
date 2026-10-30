import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { resetCaches } from "../server.mjs";
import { startMockZendesk } from "./helpers/mock-zendesk.mjs";
import {
  ACCESS_TOKEN,
  AGING_VIEW_ID,
  CONFIG_ENV,
  REQUEST_TYPE_FIELD_ID,
  SYSTEM_FIELD_ID,
  UNTRIAGED_VIEW_ID,
  applyConsoleConfig,
  clearConsoleConfig,
  clientFileFor,
  getJson,
  makeTempDir,
  removeTempDir,
  startConsole,
  writeClientFile,
  clearAccountEnv,
} from "./helpers/console.mjs";

const DAY = 86_400_000;
const UNTRIAGED_COUNT = 5;

const originalEnv = { ...process.env };

let mock;
let consoleServer;
let directory;

before(async () => {
  consoleServer = await startConsole();
  directory = await makeTempDir("operations-console-overview-");
});

after(async () => {
  await consoleServer.close();
  await removeTempDir(directory);
});

beforeEach(async () => {
  resetCaches();
  clearAccountEnv();
  // Every test reads its own mock account, so the requests it records are the
  // ones the console sent for that test. The dashboard reads two views at the
  // same time and answers with an error as soon as the first one fails, so
  // the second request can still be on its way when the test ends; it belongs
  // to this account and can no longer show up in the recording of the next
  // test.
  mock = await startMockZendesk();
  applyConsoleConfig();
  const file = await writeClientFile(directory, clientFileFor(mock.baseUrl));
  process.env.ZENDESK_OAUTH_CLIENT_FILE = file;
});

afterEach(async () => {
  await mock?.close();
  process.env = { ...originalEnv };
});

test("builds the dashboard from the aging and untriaged views", async () => {
  mock.setViewResponse(AGING_VIEW_ID, 200, { count: ROWS.length, rows: ROWS });
  mock.setViewResponse(UNTRIAGED_VIEW_ID, 200, { count: UNTRIAGED_COUNT, rows: [] });

  const { status, body } = await getJson(`${consoleServer.baseUrl}/api/overview`);

  assert.equal(status, 200);
  assert.equal(body.connected, true);
  assert.equal(body.accountUrl, mock.baseUrl);
  assert.equal(body.brandId, CONFIG_ENV.ZENDESK_CONSOLE_BRAND_ID);
  assert.equal(typeof body.lastSynced, "string");
  assert.ok(!Number.isNaN(Date.parse(body.lastSynced)));

  assert.deepEqual(body.metrics, {
    active: 10,
    untriaged: UNTRIAGED_COUNT,
    unassigned: 2,
    oldestDays: 30,
  });

  assert.deepEqual(body.aging, [
    { name: "0-2 days", count: 2 },
    { name: "3-5 days", count: 2 },
    { name: "6-10 days", count: 3 },
    { name: "11-20 days", count: 2 },
    { name: "21+ days", count: 1 },
  ]);

  // The busiest request type comes first, equal counts are ordered by name and
  // the unclassified bucket always sorts last.
  assert.deepEqual(body.requestTypes, [
    { name: "Billing", count: 4 },
    { name: "Alpha", count: 2 },
    { name: "Technical", count: 2 },
    { name: "Beta", count: 1 },
    { name: "Unclassified", count: 1 },
  ]);

  assert.equal(body.tickets.length, 8);
  assert.deepEqual(
    body.tickets.map((ticket) => ticket.id),
    [
      900000000101, 900000000102, 900000000103, 900000000104,
      900000000105, 900000000106, 900000000107, 900000000108,
    ],
  );
  assert.deepEqual(body.tickets[0], {
    id: 900000000101,
    subject: "invented subject one",
    status: "open",
    createdAt: ROWS[0].created,
    ageDays: 1,
    ageBucket: "0-2 days",
    requestType: "Billing",
    system: "invented system",
    assigneeId: 900000000901,
    url: `${mock.baseUrl}/agent/tickets/900000000101`,
  });
  assert.equal(body.tickets[2].assigneeId, null);
  assert.equal(body.tickets[2].requestType, "Billing");

  assert.deepEqual(body.views, {
    open: `${mock.baseUrl}/agent/filters/${CONFIG_ENV.ZENDESK_CONSOLE_VIEW_OPEN_ID}`,
    untriaged: `${mock.baseUrl}/agent/filters/${UNTRIAGED_VIEW_ID}`,
    aging: `${mock.baseUrl}/agent/filters/${AGING_VIEW_ID}`,
    requestType: `${mock.baseUrl}/agent/filters/${CONFIG_ENV.ZENDESK_CONSOLE_VIEW_REQUEST_TYPE_ID}`,
  });
});

test("reads both views with the token it fetched", async () => {
  mock.setViewResponse(AGING_VIEW_ID, 200, { count: ROWS.length, rows: ROWS });
  mock.setViewResponse(UNTRIAGED_VIEW_ID, 200, { count: UNTRIAGED_COUNT, rows: [] });

  await getJson(`${consoleServer.baseUrl}/api/overview`);

  assert.equal(mock.state.tokenRequests.length, 1);
  assert.deepEqual(
    mock.state.viewRequests.map((request) => request.id).sort(),
    [AGING_VIEW_ID, UNTRIAGED_VIEW_ID].sort(),
  );
  for (const request of mock.state.viewRequests) {
    assert.equal(request.authorization, `Bearer ${ACCESS_TOKEN}`);
    assert.equal(request.accept, "application/json");
  }
  assert.deepEqual(mock.state.unknownRequests, []);
});

test("serves the cached dashboard without calling the account again", async () => {
  mock.setViewResponse(AGING_VIEW_ID, 200, { count: ROWS.length, rows: ROWS });
  mock.setViewResponse(UNTRIAGED_VIEW_ID, 200, { count: UNTRIAGED_COUNT, rows: [] });

  const first = await getJson(`${consoleServer.baseUrl}/api/overview`);
  const second = await getJson(`${consoleServer.baseUrl}/api/overview`);

  assert.equal(second.status, 200);
  assert.deepEqual(second.body, first.body);
  assert.equal(mock.state.tokenRequests.length, 1);
  assert.equal(mock.state.viewRequests.length, 2);
});

test("counts a ticket without a request type as unclassified", async () => {
  mock.setViewResponse(AGING_VIEW_ID, 200, { count: 1, rows: [ROWS[9]] });
  mock.setViewResponse(UNTRIAGED_VIEW_ID, 200, { count: 0, rows: [] });

  const { status, body } = await getJson(`${consoleServer.baseUrl}/api/overview`);

  assert.equal(status, 200);
  assert.deepEqual(body.requestTypes, [{ name: "Unclassified", count: 1 }]);
  assert.equal(body.tickets[0].requestType, "Unclassified");
  assert.equal(body.tickets[0].system, "Not specified");
});

test("reports a failed view request as unavailable", async () => {
  mock.setViewResponse(AGING_VIEW_ID, 404, { error: "not found" });
  mock.setViewResponse(UNTRIAGED_VIEW_ID, 200, { count: UNTRIAGED_COUNT, rows: [] });

  const { status, body } = await getJson(`${consoleServer.baseUrl}/api/overview`);

  assert.equal(status, 503);
  assert.equal(body.connected, false);
  assert.equal(body.error, "Zendesk request failed (404)");
});

test("reports a failing account as unavailable", async () => {
  mock.setViewResponse(AGING_VIEW_ID, 500, { error: "boom" });
  mock.setViewResponse(UNTRIAGED_VIEW_ID, 200, { count: UNTRIAGED_COUNT, rows: [] });

  const { status, body } = await getJson(`${consoleServer.baseUrl}/api/overview`);

  assert.equal(status, 503);
  assert.equal(body.connected, false);
  assert.equal(body.error, "Zendesk request failed (500)");
});

test("reports a failed token request as unavailable", async () => {
  mock.setTokenResponse(401, { error: "invalid_client" });

  const { status, body } = await getJson(`${consoleServer.baseUrl}/api/overview`);

  assert.equal(status, 503);
  assert.equal(body.connected, false);
  assert.equal(body.error, "Zendesk OAuth failed (401 invalid_client)");
  assert.deepEqual(mock.state.viewRequests, []);
});

test("does not show the client file's bytes when the file is malformed", async () => {
  // The parser's message carries the file's own bytes, so the console answers
  // with its own message and the reason stays in the server log.
  const file = await writeClientFile(directory, "{ not json inventeds");
  process.env.ZENDESK_OAUTH_CLIENT_FILE = file;

  const { status, body } = await getJson(`${consoleServer.baseUrl}/api/overview`);

  assert.equal(status, 503);
  assert.equal(body.connected, false);
  assert.equal(body.error, "The Zendesk OAuth client file could not be read.");
  assert.ok(!JSON.stringify(body).includes("inventeds"));
});

test("reports a missing configuration as unavailable", async () => {
  clearConsoleConfig();

  const { status, body } = await getJson(`${consoleServer.baseUrl}/api/overview`);

  assert.equal(status, 503);
  assert.equal(body.connected, false);
  assert.match(body.error, /^Missing console configuration: /);
  assert.deepEqual(mock.state.tokenRequests, []);
  assert.deepEqual(mock.state.viewRequests, []);
});

function daysAgo(days) {
  return new Date(Date.now() - days * DAY).toISOString();
}

function row(overrides) {
  return {
    ticket: { id: 900000000100, status: "open" },
    subject: "invented subject",
    status: "open",
    created: daysAgo(1),
    assignee_id: 900000000900,
    [REQUEST_TYPE_FIELD_ID]: "Billing",
    [SYSTEM_FIELD_ID]: "invented system",
    ...overrides,
  };
}

const ROWS = [
  row({
    ticket: { id: 900000000101, status: "open" },
    subject: "invented subject one",
    created: daysAgo(1),
    assignee_id: 900000000901,
    [REQUEST_TYPE_FIELD_ID]: "Billing",
  }),
  row({
    ticket: { id: 900000000102, status: "open" },
    subject: "invented subject two",
    created: daysAgo(4),
    assignee_id: 900000000902,
    [REQUEST_TYPE_FIELD_ID]: "Billing",
  }),
  row({
    ticket: { id: 900000000103, status: "open" },
    subject: "invented subject three",
    created: daysAgo(6),
    assignee_id: null,
    [REQUEST_TYPE_FIELD_ID]: "Billing",
  }),
  row({
    ticket: { id: 900000000104, status: "open" },
    subject: "invented subject four",
    created: daysAgo(12),
    assignee_id: null,
    [REQUEST_TYPE_FIELD_ID]: "Billing",
  }),
  row({
    ticket: { id: 900000000105, status: "open" },
    subject: "invented subject five",
    created: daysAgo(1),
    assignee_id: 900000000903,
    [REQUEST_TYPE_FIELD_ID]: "Technical",
  }),
  row({
    ticket: { id: 900000000106, status: "open" },
    subject: "invented subject six",
    created: daysAgo(4),
    assignee_id: 900000000904,
    [REQUEST_TYPE_FIELD_ID]: "Technical",
  }),
  row({
    ticket: { id: 900000000107, status: "open" },
    subject: "invented subject seven",
    created: daysAgo(6),
    assignee_id: 900000000905,
    [REQUEST_TYPE_FIELD_ID]: "Alpha",
  }),
  row({
    ticket: { id: 900000000108, status: "open" },
    subject: "invented subject eight",
    created: daysAgo(6),
    assignee_id: 900000000906,
    [REQUEST_TYPE_FIELD_ID]: "Beta",
  }),
  row({
    ticket: { id: 900000000109, status: "open" },
    subject: "invented subject nine",
    created: daysAgo(30),
    assignee_id: 900000000907,
    [REQUEST_TYPE_FIELD_ID]: "Alpha",
  }),
  row({
    ticket: { id: 900000000110, status: "open" },
    subject: "invented subject ten",
    created: daysAgo(12),
    assignee_id: 900000000908,
    [REQUEST_TYPE_FIELD_ID]: undefined,
    [SYSTEM_FIELD_ID]: undefined,
  }),
];
