/**
 * Tests for the classification the console applies to the tickets of a report.
 *
 * The modules are plain ESM, so the suite imports them without a build step.
 * Every value is invented and nothing here reaches a live account or the
 * public internet.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  UNCLASSIFIED_REQUEST_TYPE,
  UNSPECIFIED_SYSTEM,
  assignmentState,
  requestTypeLabel,
  systemLabel,
  ticketRow,
} from "../src/lib/tickets.mjs";

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

test("keeps the request type of a ticket", () => {
  assert.equal(requestTypeLabel("Billing"), "Billing");
  assert.equal(requestTypeLabel("Unclassified"), UNCLASSIFIED_REQUEST_TYPE);
});

test("reports a ticket without a request type as unclassified", () => {
  assert.equal(requestTypeLabel(""), UNCLASSIFIED_REQUEST_TYPE);
  assert.equal(requestTypeLabel("   "), UNCLASSIFIED_REQUEST_TYPE);
  assert.equal(requestTypeLabel(undefined), UNCLASSIFIED_REQUEST_TYPE);
  assert.equal(requestTypeLabel(null), UNCLASSIFIED_REQUEST_TYPE);
});

test("names the system of a ticket", () => {
  assert.equal(systemLabel("invented system"), "invented system");
  assert.equal(systemLabel(""), UNSPECIFIED_SYSTEM);
  assert.equal(systemLabel(undefined), UNSPECIFIED_SYSTEM);
});

test("reports a ticket with an owner", () => {
  assert.deepEqual(assignmentState({ assigneeId: 900000000901 }), {
    label: "Assigned",
    assigned: true,
  });
});

test("reports a ticket without an owner", () => {
  assert.deepEqual(assignmentState({ assigneeId: null }), {
    label: "Unassigned",
    assigned: false,
  });
  assert.deepEqual(assignmentState({}), { label: "Unassigned", assigned: false });
});

test("builds the row the reports table shows", () => {
  assert.deepEqual(ticketRow(TICKET), {
    id: 900000000101,
    title: "#900000000101 · invented subject one",
    url: "https://example.zendesk.com/agent/tickets/900000000101",
    age: "3d",
    status: "open",
    requestType: "Billing",
    system: "invented system",
    assignment: { label: "Assigned", assigned: true },
  });
});

test("builds the row of a ticket without an owner", () => {
  const row = ticketRow({ ...TICKET, assigneeId: null, requestType: "", ageDays: 0 });

  assert.equal(row.assignment.label, "Unassigned");
  assert.equal(row.assignment.assigned, false);
  assert.equal(row.requestType, UNCLASSIFIED_REQUEST_TYPE);
  assert.equal(row.age, "0d");
});
