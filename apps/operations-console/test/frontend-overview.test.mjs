/**
 * Tests for the state the console derives from an overview payload.
 *
 * The modules are plain ESM, so the suite imports them without a build step.
 * Every value is invented and nothing here reaches a live account or the
 * public internet.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_OVERVIEW,
  connectionStatus,
  measurementIsWhole,
  measurementNote,
  openQueueHref,
  toOverviewState,
  viewHref,
} from "../src/lib/overview.mjs";

const REACHABLE = {
  connected: true,
  lastSynced: "2026-01-02T15:04:05.000Z",
  accountUrl: "https://example.zendesk.com",
  brandId: "900000000001",
  metrics: { active: 3, untriaged: 1, unassigned: 2, oldestDays: 9 },
  measured: { tickets: 3, total: 3, complete: true },
  aging: [{ name: "0-2 days", count: 3 }],
  requestTypes: [{ name: "Billing", count: 3 }],
  tickets: [],
  views: { open: "https://example.zendesk.com/agent/filters/900000000004" },
};

test("keeps the payload of a reachable account", () => {
  const overview = toOverviewState(REACHABLE);

  assert.equal(overview, REACHABLE);
  assert.equal(overview.connected, true);
  assert.equal(overview.metrics.active, 3);
});

test("maps an unreachable account onto the empty overview", () => {
  const overview = toOverviewState({ connected: false, error: "Zendesk request failed (503)" });

  assert.equal(overview.connected, false);
  assert.equal(overview.error, "Zendesk request failed (503)");
  assert.equal(overview.lastSynced, "");
  assert.equal(overview.brandId, "");
  assert.deepEqual(overview.metrics, { active: 0, untriaged: 0, unassigned: 0, oldestDays: 0 });
  assert.deepEqual(overview.aging, []);
  assert.deepEqual(overview.requestTypes, []);
  assert.deepEqual(overview.tickets, []);
  assert.deepEqual(overview.views, {});
});

test("reports an unreachable account without a message", () => {
  const overview = toOverviewState({ connected: false });

  assert.equal(overview.connected, false);
  assert.equal(overview.error, undefined);
});

test("maps a payload that is not an object onto the empty overview", () => {
  const overview = toOverviewState(undefined);

  assert.equal(overview.connected, false);
  assert.equal(overview.error, undefined);
  assert.deepEqual(overview.metrics, EMPTY_OVERVIEW.metrics);
});

test("describes a reachable account", () => {
  const status = connectionStatus(REACHABLE);

  assert.equal(status.connected, true);
  assert.equal(status.title, "Zendesk connected");
  assert.match(status.detail, /^Synced /);
});

test("describes an unreachable account with the message of the server", () => {
  const status = connectionStatus({ connected: false, error: "Zendesk request failed (503)" });

  assert.equal(status.connected, false);
  assert.equal(status.title, "Zendesk unavailable");
  assert.equal(status.detail, "Zendesk request failed (503)");
});

test("points at the OAuth configuration when the server reports no reason", () => {
  assert.equal(connectionStatus({ connected: false }).detail, "Check OAuth configuration");
  assert.equal(connectionStatus({ connected: false, error: "" }).detail, "Check OAuth configuration");
});

test("says nothing when the whole view was measured", () => {
  assert.equal(measurementNote(REACHABLE.measured), "");
  assert.equal(measurementNote({ tickets: 3, total: 3, complete: true }), "");
  assert.equal(measurementNote(undefined), "");
});

test("knows when the dashboard describes the whole view", () => {
  assert.equal(measurementIsWhole({ tickets: 3, total: 3, complete: true }), true);
  assert.equal(measurementIsWhole({ tickets: 3, total: null, complete: true }), true);
  // The console did not read the whole view, so the dashboard describes a part
  // of it even when the count happens to match.
  assert.equal(measurementIsWhole({ tickets: 2000, total: 2000, complete: false }), false);
  assert.equal(measurementIsWhole({ tickets: 2000, total: 5000, complete: false }), false);
  // The count and the tickets disagree, so the dashboard does not describe
  // one view.
  assert.equal(measurementIsWhole({ tickets: 3, total: 5000, complete: true }), false);
  assert.equal(measurementIsWhole({ tickets: 0, total: 5000, complete: true }), false);
  assert.equal(measurementIsWhole(undefined), false);
});

test("names the tickets it read when the view is longer", () => {
  const note = measurementNote({ tickets: 2000, total: 5000, complete: false });

  assert.match(note, /2000/);
  assert.match(note, /5000/);
  // The note must not claim that every number is a total: the unassigned
  // figure and the oldest ticket are measured from the tickets that were read.
  assert.match(note, /unassigned figure, the oldest ticket/);
  assert.match(note, /measured from the tickets that were read/);
  assert.ok(!/headline numbers are the totals/.test(note));
});

test("names the tickets it read when the account states no count", () => {
  const note = measurementNote({ tickets: 2000, total: null, complete: false });

  assert.match(note, /2000/);
  assert.match(note, /measured from the tickets that were read/);
  // The account states no count, so the active figure is the number of
  // tickets the console read. The console did not read the whole view, so
  // that number is a floor and the note has to say so.
  assert.match(note, /active figure is the number of tickets the console read/);
  assert.match(note, /floor rather than the size of the view/);
});

test("does not call the active figure a floor when the account states a count", () => {
  // The account states how many tickets the view holds, so the active figure
  // is that count and not the number of tickets the console read.
  const note = measurementNote({ tickets: 300, total: 5000, complete: false });

  assert.match(note, /the first 300 tickets of the view/);
  assert.match(note, /5000/);
  assert.ok(!/floor/.test(note), "the count of the account is not a floor");
});

test("does not call a view it read whole a part of one", () => {
  // The account says the view holds five thousand tickets and serves three
  // hundred of them, and then offers no further page. The console read every
  // ticket the view served, so the note must not say it read a part of the
  // view: the count is the number that cannot be trusted.
  const note = measurementNote({ tickets: 300, total: 5000, complete: true });

  assert.match(note, /300/);
  assert.match(note, /5000/);
  assert.match(note, /disagree/);
  assert.ok(!/the first/.test(note), "a view read whole is not a part of the view");
  assert.ok(!/floor/.test(note), "the count of the account is not a floor");
});

test("names the disagreement when the count and the rows differ", () => {
  const note = measurementNote({ tickets: 10, total: 3, complete: true });

  assert.match(note, /10/);
  assert.match(note, /3/);
  assert.match(note, /disagree/);
  assert.match(note, /measured from the tickets that were read/);
});

test("says the count is too low when the console read more than the account counted", () => {
  // The account counted fewer tickets than the console read, so the count
  // cannot be the size of the view and the active figure is too low.
  const note = measurementNote({ tickets: 2000, total: 500, complete: false });

  assert.match(note, /500/);
  assert.match(note, /2000/);
  assert.match(note, /disagree/);
  // The count is the account's, so the active figure is that count.
  assert.match(note, /active figure is the account's count/);
});

test("says the view holds more when the count matches what was read", () => {
  // The count equals the tickets read, but the console stopped at the page
  // limit with a page left to read, so the count cannot be the size of the
  // view either.
  const note = measurementNote({ tickets: 2000, total: 2000, complete: false });

  assert.match(note, /2000/);
  assert.match(note, /pages the console did not read/);
  assert.match(note, /disagree/);
});

test("says something when the account counted tickets the console never read", () => {
  // Nothing was measured, but the account states a count. The two disagree
  // in the strongest way there is, and the note has to say so: without it the
  // dashboard shows a headline over an all-zero breakdown and no
  // qualification.
  const whole = measurementNote({ tickets: 0, total: 5000, complete: true });

  assert.notEqual(whole, "");
  assert.match(whole, /no tickets/);
  assert.match(whole, /5000/);
  assert.match(whole, /disagree/);

  // The view still had a page to offer, so the console cannot say the view
  // served no tickets: the pages it read served none, and the count may well
  // be right.
  const partial = measurementNote({ tickets: 0, total: 5000, complete: false });

  assert.notEqual(partial, "");
  assert.match(partial, /no tickets/);
  assert.match(partial, /5000/);
  assert.match(partial, /pages the console did not read/);
  assert.match(partial, /measured nothing/);
  assert.ok(!/disagree/.test(partial), "the count is not shown to be wrong");
});

test("says nothing when the console could not reach its server", () => {
  // A console that could not reach its server has no measurement to disclose:
  // the empty payload it shows is not a measurement of an empty queue, so a
  // note that said the console read no tickets would read as one.
  assert.equal(measurementNote({ tickets: 0, total: null, complete: false }, false), "");
});

test("says something when a connected account served no rows at all", () => {
  // The same measurement, from an account that was reached: the console
  // cannot tell the two apart by the measurement alone, so it keys the
  // silence on the connection and not on the shape.
  const note = measurementNote({ tickets: 0, total: null, complete: false }, true);

  assert.notEqual(note, "");
  assert.match(note, /no tickets/);
  assert.match(note, /floor rather than the size of the view/);
});

test("says that a page was left when the account counts nothing", () => {
  // The account counts nothing and the view still had a page to offer. The
  // count is not shown to be wrong — it may be right and the pages may have
  // come back empty — but the note says that the console measured nothing.
  const note = measurementNote({ tickets: 0, total: 0, complete: false });

  assert.notEqual(note, "");
  assert.match(note, /no tickets/);
  assert.match(note, /pages the console did not read/);
  assert.match(note, /measured nothing/);
});

test("says what the triage figure is", () => {
  // The triage figure is the account's count of the untriaged view, whose
  // rows the console never reads. The operator is told where the other
  // figures come from, and is told about this one too.
  const note = measurementNote({ tickets: 2000, total: 5000, complete: false });

  assert.match(note, /triage figure is the account's count of the untriaged view/);
});

test("links to a view of the account", () => {
  const views = { open: "https://example.zendesk.com/agent/filters/900000000004" };

  assert.equal(viewHref(views, "open"), "https://example.zendesk.com/agent/filters/900000000004");
  assert.equal(viewHref(views, "aging"), "#");
  assert.equal(viewHref({}, "open"), "#");
  assert.equal(viewHref(undefined, "open"), "#");
});

test("links to the open queue of the account", () => {
  assert.equal(
    openQueueHref(REACHABLE),
    "https://example.zendesk.com/agent/filters/900000000004",
  );
  assert.equal(
    openQueueHref({ accountUrl: "https://example.zendesk.com", views: {} }),
    "https://example.zendesk.com/agent/home/tickets",
  );
});
