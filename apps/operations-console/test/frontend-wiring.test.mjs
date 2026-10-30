/**
 * Tests for the wiring between the extracted modules and the components.
 *
 * The components are TSX, so the suite cannot render them without a build
 * step and without a DOM. Instead it reads the source of the component and
 * checks two things: that the console renders the values the modules build,
 * and that the component holds no copy of the logic that moved into the
 * modules.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ticketRow } from "../src/lib/tickets.mjs";

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

/**
 * The source of the load function of the console.
 *
 * The suite cannot render the components, so it reads their source. The load
 * is read on its own, so that a change around it cannot hide a change to it.
 *
 * @returns {string}
 */
function loadSource() {
  const start = appSource.indexOf("const load = async () => {");
  assert.notEqual(start, -1, "the console must have a load function");
  const end = appSource.indexOf("\n  };", start);
  assert.notEqual(end, -1, "the load function must end");
  return appSource.slice(start, end);
}

/**
 * The source with its comments removed.
 *
 * The suite counts calls in the source, and a comment that names a call
 * would be counted as one.
 *
 * @param {string} source
 * @returns {string}
 */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

 /**
 * The source of one page component of the console.
 *
 * The suite cannot render the components, so it reads their source. Each page
 * is read on its own, so that a change to one of them cannot be masked by a
 * change to another.
 *
 * @param {string} name the name of the page component
 * @returns {string}
 */
function pageSource(name) {
  const start = appSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must be a component of the console`);
  const end = appSource.indexOf("\nfunction ", start + 1);
  return appSource.slice(start, end === -1 ? appSource.length : end);
}

const TICKET = {
  id: 900000000101,
  subject: "invented subject one",
  status: "open",
  createdAt: "2026-01-01T00:00:00.000Z",
  ageDays: 3,
  ageBucket: "3-5 days",
  requestType: "Billing",
  system: "invented system",
  assigneeId: 900000000901,
  url: "https://example.zendesk.com/agent/tickets/900000000101",
};

test("the components call the extracted modules", () => {
  for (const module of ["format", "knowledge", "metrics", "navigation", "overview", "tickets"]) {
    assert.match(appSource, new RegExp(`from "\\./lib/${module}\\.mjs"`));
  }
});

test("the components hold no copy of the extracted logic", () => {
  // The wording the modules own does not appear in the components any more.
  // The metric card named "Unassigned" is a title of the console and not the
  // owner of a ticket, so it stays where it is.
  for (const literal of [
    "Not connected",
    "Not configured",
    "Unclassified",
    "Not specified",
    "Zendesk connected",
    "Zendesk unavailable",
    "Check OAuth configuration",
  ]) {
    assert.ok(!appSource.includes(literal), `expected the components to leave "${literal}" to the modules`);
  }
  // The decisions the modules own are not taken in the components any more.
  for (const decision of [
    "toLowerCase()",
    "Math.max(1,",
    "JSON.parse",
    "location.hash.slice(1)",
    "assigneeId ?",
    "{ticket.ageDays}",
    "{ticket.requestType}",
    "{ticket.system}",
    "{ticket.status}",
    "{ticket.url}",
  ]) {
    assert.ok(!appSource.includes(decision), `expected the components to leave "${decision}" to the modules`);
  }
});

test("the reports table renders what the ticket module builds", () => {
  const row = ticketRow(TICKET);

  assert.deepEqual(row, {
    id: 900000000101,
    title: "#900000000101 · invented subject one",
    url: "https://example.zendesk.com/agent/tickets/900000000101",
    age: "3d",
    status: "open",
    requestType: "Billing",
    system: "invented system",
    assignment: { label: "Assigned", assigned: true },
  });

  // The table renders the values of the row and nothing else.
  assert.match(appSource, /\{row\.id\}/);
  assert.match(appSource, /\{row\.title\}/);
  assert.match(appSource, /\{row\.age\}/);
  assert.match(appSource, /\{row\.status\}/);
  assert.match(appSource, /\{row\.requestType\}/);
  assert.match(appSource, /\{row\.system\}/);
  assert.match(appSource, /\{row\.assignment\.label\}/);
});

test("the overview page renders the row of the oldest ticket", () => {
  const row = ticketRow(TICKET);

  assert.match(appSource, /\{oldest\.url\}/);
  assert.match(appSource, /\{oldest\.title\}/);
  assert.equal(row.title, "#900000000101 · invented subject one");
});

test("a failed load is reported instead of shown as an empty dashboard", () => {
  // The component asks the loader for the dashboard and for the failure, and
  // renders the failure: a console that cannot reach its server must not
  // render zeros, which read as a quiet account rather than an unreachable
  // console. The loader itself is covered in frontend-overview.test.mjs.
  assert.match(appSource, /loadOverview\(/);
  assert.match(appSource, /setFailure\(loaded\.failure\)/);
  assert.match(appSource, /failure &&/);
});

test("the failure reason that is rendered is the console's own message", () => {
  // The band shows the text the console wrote, not a guess, and the text is
  // marked as an alert so that it is announced.
  assert.match(appSource, /role="alert"/);
  assert.match(appSource, /<strong>\{failure\}<\/strong>/);
});

test("the spinner is stopped even when the load failed", () => {
  // The loading state is cleared in a finally, and only by the newest load,
  // so a failed load cannot leave the spinner turning.
  assert.match(appSource, /finally \{ if \(sequence\.isCurrent\(id\)\) setLoading\(false\); \}/);
});

test("only the newest load may write", () => {
  // Two loads can overlap, and the older one may settle last. The component
  // asks the sequence which load is the newest; the sequence itself is
  // covered in frontend-overview.test.mjs.
  const raw = loadSource();
  const load = withoutComments(raw);
  assert.match(load, /const id = sequence\.begin\(\);/);
  assert.match(load, /if \(!sequence\.isCurrent\(id\)\) return;/);
  // One load begins one sequence entry: two calls would make every load a
  // no-op, and the suite would stay green. The entry is begun inside the
  // load, so a render cannot take one in the load's place.
  assert.equal((load.match(/sequence\.begin\s*\(\s*\)/g) ?? []).length, 1);
  assert.ok(
    !withoutComments(appSource.replace(raw, "")).includes("sequence.begin"),
    "only the load may begin a sequence entry",
  );
  // The guard runs where the load settles, after the wait, and before either
  // write. A guard that ran before the wait would always be true, and a
  // superseded load would write; a load that wrote a failure without asking
  // would show a failure for an account that is reachable.
  const guard = load.indexOf("if (!sequence.isCurrent(id)) return;");
  assert.ok(
    guard > load.indexOf("await loadOverview()"),
    "the guard must run where the load settles",
  );
  assert.ok(guard < load.indexOf("setData("), "the guard must run before the overview is written");
  assert.ok(guard < load.indexOf("setFailure("), "the guard must run before the failure is written");
});

test("the account blocker is shown only when there are unassigned tickets", () => {
  // Every number is zero when the load failed, and a band that says the
  // queue has no assigned agent would turn a failure into a claim about the
  // account. The band is only true when the count is.
  assert.match(appSource, /data\.metrics\.unassigned > 0 && <section className="alert-band">/);
});

test("the alert band states a fact about the queue only when the dashboard describes it whole", () => {
  const overview = pageSource("OverviewPage");
  // The band keys on the measurement itself, not on the note. The note is
  // empty whenever the whole view was read and the account agrees, but the
  // band has to know that rather than infer it: a band that claims "0 active
  // tickets are currently unassigned" over a queue of five thousand tickets
  // the console never read says something the console cannot support.
  assert.match(overview, /measurementIsWhole\(data\.measured\)/);
  assert.match(overview, /whole \? "active tickets are"/);
});

test("both pages that show a breakdown say how much of the view was measured", () => {
  // The note is built by the module, and it is rendered on the dashboard and
  // on the queue reports: the request-type breakdown exists only on the
  // reports page, so a note that was only on the dashboard would leave that
  // breakdown undisclosed. Counting the render sites is not enough: two
  // notes on one page would satisfy a count, so each page is checked on its
  // own.
  const overview = pageSource("OverviewPage");
  const reports = pageSource("ReportsPage");

  assert.match(overview, /measurementNote\(data\.measured, data\.connected\)/);
  assert.match(reports, /measurementNote\(data\.measured, data\.connected\)/);
  assert.match(overview, /<MeasurementNote note=\{note\} \/>/);
  assert.match(reports, /<MeasurementNote note=\{note\} \/>/);
  // Each page shows the note above the breakdown it describes, so a note that
  // moved below it would read as a footnote of a breakdown the operator has
  // already taken for a whole one.
  assert.ok(
    overview.indexOf("<MeasurementNote note={note} />") < overview.indexOf('className="metric-grid"'),
    "the overview shows the note above the metrics",
  );
  assert.ok(
    reports.indexOf("<MeasurementNote note={note} />") < reports.indexOf('className="report-grid"'),
    "the reports show the note above the breakdowns",
  );
});

test("the workstream panel says that its statuses are not measured", () => {
  // The workstream panel states facts about work the console never read. The
  // values are invented on purpose — it is a reference app — so the panel has
  // to say so, or a reader cannot tell it apart from the panels that are
  // measured from the account. The caption sits next to the heading, so it
  // is checked there and not anywhere else on the page.
  const overview = pageSource("OverviewPage");

  assert.match(
    overview,
    /<h2>Workstream readiness<\/h2><p>[^<]*[Ii]llustrative[^<]*not measured from the account[^<]*<\/p>/,
  );
});
