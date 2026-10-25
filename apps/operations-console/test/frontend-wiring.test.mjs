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
