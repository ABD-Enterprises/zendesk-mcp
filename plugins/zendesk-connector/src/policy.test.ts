import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { configuredTools, toolNames } from "./policy.js";

const originalTools = process.env.ZENDESK_ALLOWED_TOOLS;

afterEach(() => {
  if (originalTools === undefined) delete process.env.ZENDESK_ALLOWED_TOOLS;
  else process.env.ZENDESK_ALLOWED_TOOLS = originalTools;
});

test("defaults to all compiled tools", () => {
  delete process.env.ZENDESK_ALLOWED_TOOLS;
  assert.deepEqual([...configuredTools()], toolNames());
});

test("accepts an explicit least-privilege allowlist", () => {
  process.env.ZENDESK_ALLOWED_TOOLS = "zendesk_status, zendesk_search_tickets";
  assert.deepEqual([...configuredTools()], ["zendesk_status", "zendesk_search_tickets"]);
});

test("rejects empty, duplicate, and unknown allowlist entries", () => {
  for (const value of [", ,", "zendesk_status,zendesk_status", "zendesk_delete_all"]) {
    process.env.ZENDESK_ALLOWED_TOOLS = value;
    assert.throws(() => configuredTools(), /ZENDESK_ALLOWED_TOOLS/);
  }
});
