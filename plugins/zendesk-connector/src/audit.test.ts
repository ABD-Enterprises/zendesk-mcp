import assert from "node:assert/strict";
import { test } from "node:test";
import {
  audit,
  logOAuthLogout,
  logServerShutdown,
  logServerStart,
  redact,
} from "./audit.js";
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

test("runs the tool call event through the house filter", () => {
  const lines = captureStderr(() => {
    audit({
      tool: "zendesk_search_tickets",
      operation: "read",
      outcome: "success",
      actorId: "access_token=AT-111",
    });
  });

  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes("AT-111"));
  assert.ok(lines[0].includes("[REDACTED]"));
});

test("scrubs a credential parked in the value of an innocuous name", () => {
  const scrubbed = redact(
    "client_secret super-secret-value rejected by the token endpoint",
  ) as string;

  assert.ok(!scrubbed.includes("super-secret-value"));
  assert.ok(scrubbed.includes("[REDACTED]"));
});

test("scrubs a credential that is assigned to a sensitive name", () => {
  for (const text of [
    "access_token=AT-111 raw body",
    '{"access_token":"AT-111"}',
    "Bearer AT-111",
  ]) {
    const scrubbed = redact(text) as string;
    assert.ok(!scrubbed.includes("AT-111"), `not scrubbed: ${text}`);
  }
});

test("keeps ordinary text and prose around a sensitive name", () => {
  for (const text of [
    "Request failed",
    "Zendesk API request failed: HTTP 403 Forbidden",
    "No refresh token found in /tmp/oauth.json. Run npm run oauth:setup.",
    "the password was rejected",
    "token rotation is overdue",
  ]) {
    assert.equal(redact(text), text);
  }
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

test("logs an OAuth logout event without credential material", () => {
  const lines: string[] = [];

  logOAuthLogout(
    {
      mode: "authorization_code",
      outcome: "success",
      revoked: true,
      clearedCache: true,
      storedCredentials: "removed",
    },
    (line) => lines.push(line),
  );

  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.event, "zendesk_oauth_logout");
  assert.equal(event.mode, "authorization_code");
  assert.equal(event.outcome, "success");
  assert.equal(event.revoked, true);
  assert.equal(event.clearedCache, true);
  assert.equal(event.storedCredentials, "removed");
  assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T.*Z$/);
});

test("names no credential fields in the OAuth logout event", () => {
  const lines: string[] = [];

  logOAuthLogout(
    {
      mode: "access_token",
      outcome: "error",
      revoked: false,
      status: 403,
      error: "Zendesk API request failed: HTTP 403 Forbidden",
      clearedCache: true,
      storedCredentials: "kept",
    },
    (line) => lines.push(line),
  );

  const event = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(event).sort(), [
    "clearedCache",
    "error",
    "event",
    "mode",
    "outcome",
    "revoked",
    "status",
    "storedCredentials",
    "timestamp",
  ]);
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
