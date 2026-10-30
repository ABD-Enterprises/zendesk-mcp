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

test("both pages that show a breakdown say how much of the view was measured", () => {
  // The note is built by the module, and it is rendered on the dashboard and
  // on the queue reports: the request-type breakdown exists only on the
  // reports page, so a note that was only on the dashboard would leave that
  // breakdown undisclosed. Counting the render sites is not enough: two
  // notes on one page would satisfy a count, so each page is checked on its
  // own.
  const overview = pageSource("OverviewPage");
  const reports = pageSource("ReportsPage");

  assert.match(overview, /measurementNote\(data\.measured\)/);
  assert.match(reports, /measurementNote\(data\.measured\)/);
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
