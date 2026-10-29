import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { configuredTools, toolNames } from "./policy.js";

const originalTools = process.env.ZENDESK_ALLOWED_TOOLS;
const originalReadOnly = process.env.ZENDESK_READ_ONLY;

afterEach(() => {
  if (originalTools === undefined) delete process.env.ZENDESK_ALLOWED_TOOLS;
  else process.env.ZENDESK_ALLOWED_TOOLS = originalTools;
  if (originalReadOnly === undefined) delete process.env.ZENDESK_READ_ONLY;
  else process.env.ZENDESK_READ_ONLY = originalReadOnly;
});

test("defaults to all compiled tools", () => {
  delete process.env.ZENDESK_ALLOWED_TOOLS;
  delete process.env.ZENDESK_READ_ONLY;
  assert.deepEqual([...configuredTools()], toolNames());
});

test("accepts an explicit least-privilege allowlist", () => {
  process.env.ZENDESK_ALLOWED_TOOLS = "zendesk_status, zendesk_search_tickets";
  assert.deepEqual([...configuredTools()], ["zendesk_status", "zendesk_search_tickets"]);
});

test("rejects empty, duplicate, and unknown allowlist entries", () => {
  delete process.env.ZENDESK_READ_ONLY;
  for (const value of [", ,", "zendesk_status,zendesk_status", "zendesk_delete_all"]) {
    process.env.ZENDESK_ALLOWED_TOOLS = value;
    assert.throws(() => configuredTools(), /ZENDESK_ALLOWED_TOOLS/);
  }
});

const WRITE_TOOL_NAMES = [
  "zendesk_create_ticket",
  "zendesk_update_ticket",
  "zendesk_add_ticket_comment",
];

test("read-only mode keeps the nine read tools and drops the three write tools", () => {
  delete process.env.ZENDESK_ALLOWED_TOOLS;
  const readToolNames = toolNames().filter((tool) => !WRITE_TOOL_NAMES.includes(tool));
  for (const value of ["1", "true", "TRUE", " True "]) {
    process.env.ZENDESK_READ_ONLY = value;
    assert.deepEqual([...configuredTools()], [...readToolNames]);
  }
});

test("read-only mode accepts disabled values and an unset variable", () => {
  delete process.env.ZENDESK_ALLOWED_TOOLS;
  for (const value of ["0", "false", "FALSE", ""]) {
    process.env.ZENDESK_READ_ONLY = value;
    assert.deepEqual([...configuredTools()], toolNames());
  }
});

test("read-only mode rejects unrecognized values", () => {
  for (const value of ["yes", "no", "on", "2"]) {
    process.env.ZENDESK_READ_ONLY = value;
    assert.throws(() => configuredTools(), /ZENDESK_READ_ONLY/);
  }
});

test("an explicit allowlist wins over read-only mode when it names only read tools", () => {
  process.env.ZENDESK_READ_ONLY = "1";
  process.env.ZENDESK_ALLOWED_TOOLS = "zendesk_status, zendesk_search_tickets";
  assert.deepEqual([...configuredTools()], ["zendesk_status", "zendesk_search_tickets"]);
});

test("read-only mode rejects an allowlist that names a write tool", () => {
  process.env.ZENDESK_READ_ONLY = "1";
  process.env.ZENDESK_ALLOWED_TOOLS =
    "zendesk_status,zendesk_update_ticket,zendesk_create_ticket";
  assert.throws(
    () => configuredTools(),
    /ZENDESK_READ_ONLY conflicts with write tools in ZENDESK_ALLOWED_TOOLS: zendesk_update_ticket, zendesk_create_ticket/,
  );
});
