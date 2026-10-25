import assert from "node:assert/strict";
import { test } from "node:test";
import { audit, logServerShutdown, logServerStart, redact } from "./audit.js";
import { PACKAGE_VERSION } from "./version.js";

test("redacts sensitive keys recursively without changing ordinary values", () => {
  assert.deepEqual(
    redact({
      message: "Request failed",
      response: { access_token: "secret", nested: { password: "secret", code: 401 } },
    }),
    {
      message: "Request failed",
      response: {
        access_token: "[REDACTED]",
        nested: { password: "[REDACTED]", code: 401 },
      },
    },
  );
});

test("keeps the tool call event shape", () => {
  const lines = captureStderr(() => {
    audit({
      tool: "zendesk_search_tickets",
      operation: "read",
      outcome: "success",
      actorId: 42,
    });
  });

  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    event: "zendesk_tool_call",
    tool: "zendesk_search_tickets",
    operation: "read",
    outcome: "success",
    timestamp: JSON.parse(lines[0]).timestamp,
    actorId: 42,
  });
});

test("logs a server start event with the package version", () => {
  const lines: string[] = [];

  logServerStart((line) => lines.push(line));

  assert.equal(lines.length, 1);
  assert.equal(lines[0].split("\n").length, 2);
  const event = JSON.parse(lines[0]);
  assert.equal(event.event, "server_start");
  assert.equal(event.name, "zendesk-mcp");
  assert.equal(event.version, PACKAGE_VERSION);
  assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T.*Z$/);
});

test("logs a server shutdown event with the trigger and exit code", () => {
  const lines: string[] = [];

  logServerShutdown({ trigger: "sigterm", exitCode: 143 }, (line) =>
    lines.push(line),
  );

  assert.equal(lines.length, 1);
  assert.equal(lines[0].split("\n").length, 2);
  const event = JSON.parse(lines[0]);
  assert.equal(event.event, "server_shutdown");
  assert.equal(event.trigger, "sigterm");
  assert.equal(event.exitCode, 143);
});

test("redacts token-like values in lifecycle details", () => {
  const lines: string[] = [];

  logServerShutdown(
    {
      trigger: "sigint",
      exitCode: 0,
      details: { access_token: "invented-secret", reason: "example" },
    },
    (line) => lines.push(line),
  );

  assert.ok(!lines[0].includes("invented-secret"));
  const event = JSON.parse(lines[0]);
  assert.equal(event.details.access_token, "[REDACTED]");
  assert.equal(event.details.reason, "example");
});

function captureStderr(run: () => void): string[] {
  const lines: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}
