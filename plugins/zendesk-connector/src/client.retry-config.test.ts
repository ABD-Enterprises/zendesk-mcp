import assert from "node:assert/strict";
import { test } from "node:test";
import { ZendeskClient, ZendeskError } from "./client.js";
import type { ZendeskConfig } from "./auth.js";

/**
 * Hermetic behavioral regression tests for the retry environment
 * configuration (`ZENDESK_MAX_RETRIES`, `ZENDESK_MAX_RETRY_DELAY_MS`).
 *
 * The client reads both settings in its constructor, so each scenario sets
 * the relevant `process.env` keys, constructs the client, and restores the
 * previous environment in a `finally` block. Requests are served by an
 * injected in-memory fetcher (fake 429 + Retry-After, then fake success) and
 * waits are recorded by an injected sleep, so the tests assert on observable
 * request counts and injected wait durations only. No network, credentials,
 * or token files are involved.
 */

const RETRIES_ENV = "ZENDESK_MAX_RETRIES";
const DELAY_ENV = "ZENDESK_MAX_RETRY_DELAY_MS";

const DEFAULT_RETRIES = 2;
const DEFAULT_DELAY_MS = 10_000;

function accessTokenConfig(): ZendeskConfig {
  return {
    // If the injected fetcher is ever bypassed, this points only at loopback
    // and fails closed instead of making an external request.
    baseUrl: "http://127.0.0.1:1",
    mode: "access_token",
    accessToken: "oauth-access-token",
    tokenFile: "/unused/oauth.json",
    scope: "tickets:read",
  };
}

interface ScenarioOutcome {
  calls: number;
  sleeps: number[];
  result?: unknown;
  error?: ZendeskError;
}

/**
 * Runs one retry scenario. The injected fetcher answers the first
 * `rateLimitedCalls` requests with a fake 429 carrying `retryAfterSeconds`
 * and every later request with a fake success payload.
 */
function runScenario(options: {
  env: Record<string, string | undefined>;
  rateLimitedCalls: number;
  retryAfterSeconds: string;
}): Promise<ScenarioOutcome> {
  let calls = 0;
  const sleeps: number[] = [];
  const fetcher: typeof fetch = async () => {
    calls += 1;
    if (calls <= options.rateLimitedCalls) {
      return Response.json(
        { error: "rate_limited" },
        { status: 429, headers: { "retry-after": options.retryAfterSeconds } },
      );
    }
    return Response.json({ tickets: [] });
  };
  const sleep = async (milliseconds: number): Promise<void> => {
    sleeps.push(milliseconds);
  };

  const saved = new Map(
    Object.keys(options.env).map((key) => [key, process.env[key]] as const),
  );
  let client: ZendeskClient;
  try {
    for (const [key, value] of Object.entries(options.env)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    // The constructor reads the retry settings from the environment.
    client = new ZendeskClient(accessTokenConfig(), fetcher, sleep);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  return (async (): Promise<ScenarioOutcome> => {
    try {
      const result = await client.request("/tickets.json");
      return { calls, sleeps, result };
    } catch (error) {
      assert.ok(error instanceof ZendeskError);
      return { calls, sleeps, error };
    }
  })();
}

test("scenario restores prior retry env values after constructing the client", async () => {
  const savedRetries = process.env[RETRIES_ENV];
  const savedDelay = process.env[DELAY_ENV];
  try {
    process.env[RETRIES_ENV] = "1";
    process.env[DELAY_ENV] = "1";
    const outcome = await runScenario({
      env: { [RETRIES_ENV]: undefined, [DELAY_ENV]: undefined },
      rateLimitedCalls: 1,
      retryAfterSeconds: "0",
    });
    assert.equal(outcome.calls, 2);
    assert.deepEqual(outcome.sleeps, [0]);
    // The scenario must restore the values that were present before it ran.
    assert.equal(process.env[RETRIES_ENV], "1");
    assert.equal(process.env[DELAY_ENV], "1");
  } finally {
    if (savedRetries === undefined) {
      delete process.env[RETRIES_ENV];
    } else {
      process.env[RETRIES_ENV] = savedRetries;
    }
    if (savedDelay === undefined) {
      delete process.env[DELAY_ENV];
    } else {
      process.env[DELAY_ENV] = savedDelay;
    }
  }
});

test("whitespace-only ZENDESK_MAX_RETRIES counts as unset (regression)", async () => {
  // Per the documented parsing rules a value of only whitespace is trimmed
  // to empty and counts as unset, so the default of 2 retries applies. The
  // unpatched parser reads it as 0 and disables retries entirely. Three
  // consecutive 429s prove the fallback is exactly the default of 2: the
  // third request is still rate-limited and surfaces the 429 error.
  const outcome = await runScenario({
    env: { [RETRIES_ENV]: "   ", [DELAY_ENV]: undefined },
    rateLimitedCalls: 3,
    retryAfterSeconds: "1",
  });
  assert.ok(outcome.error instanceof ZendeskError);
  assert.equal(outcome.error.status, 429);
  assert.equal(outcome.calls, 3);
  assert.deepEqual(outcome.sleeps, [1000, 1000]);
});

test("whitespace-only ZENDESK_MAX_RETRY_DELAY_MS counts as unset (regression)", async () => {
  // Same regression for the wait cap: whitespace-only must fall back to the
  // 10s default instead of parsing as 0, which rejects every retry delay.
  const outcome = await runScenario({
    env: { [RETRIES_ENV]: undefined, [DELAY_ENV]: "\t\n " },
    rateLimitedCalls: 1,
    retryAfterSeconds: "2",
  });
  assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.result, { tickets: [] });
  assert.equal(outcome.calls, 2);
  assert.deepEqual(outcome.sleeps, [2000]);
});

test("blank ZENDESK_MAX_RETRIES counts as unset", async () => {
  // Three consecutive 429s prove the fallback is exactly the default of 2.
  const outcome = await runScenario({
    env: { [RETRIES_ENV]: "", [DELAY_ENV]: undefined },
    rateLimitedCalls: 3,
    retryAfterSeconds: "1",
  });
  assert.ok(outcome.error instanceof ZendeskError);
  assert.equal(outcome.error.status, 429);
  assert.equal(outcome.calls, 3);
  assert.deepEqual(outcome.sleeps, [1000, 1000]);
});

test("blank ZENDESK_MAX_RETRY_DELAY_MS counts as unset", async () => {
  const outcome = await runScenario({
    env: { [RETRIES_ENV]: undefined, [DELAY_ENV]: "" },
    rateLimitedCalls: 1,
    retryAfterSeconds: "2",
  });
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.calls, 2);
  assert.deepEqual(outcome.sleeps, [2000]);
});

test("unresolved placeholder for ZENDESK_MAX_RETRIES counts as unset", async () => {
  // Three consecutive 429s prove the fallback is exactly the default of 2.
  const outcome = await runScenario({
    env: { [RETRIES_ENV]: "${ZENDESK_MAX_RETRIES}", [DELAY_ENV]: undefined },
    rateLimitedCalls: 3,
    retryAfterSeconds: "1",
  });
  assert.ok(outcome.error instanceof ZendeskError);
  assert.equal(outcome.error.status, 429);
  assert.equal(outcome.calls, 3);
  assert.deepEqual(outcome.sleeps, [1000, 1000]);
});

test("unresolved placeholder for ZENDESK_MAX_RETRY_DELAY_MS counts as unset", async () => {
  const outcome = await runScenario({
    env: {
      [RETRIES_ENV]: undefined,
      [DELAY_ENV]: "${ZENDESK_MAX_RETRY_DELAY_MS}",
    },
    rateLimitedCalls: 1,
    retryAfterSeconds: "2",
  });
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.calls, 2);
  assert.deepEqual(outcome.sleeps, [2000]);
});

test("explicit zero ZENDESK_MAX_RETRIES disables retries", async () => {
  const outcome = await runScenario({
    env: { [RETRIES_ENV]: "0", [DELAY_ENV]: undefined },
    rateLimitedCalls: 1,
    retryAfterSeconds: "1",
  });
  assert.ok(outcome.error instanceof ZendeskError);
  assert.equal(outcome.error.status, 429);
  assert.equal(outcome.calls, 1);
  assert.deepEqual(outcome.sleeps, []);
});

test("explicit zero ZENDESK_MAX_RETRY_DELAY_MS still allows zero waits", async () => {
  const outcome = await runScenario({
    env: { [RETRIES_ENV]: undefined, [DELAY_ENV]: "0" },
    rateLimitedCalls: 1,
    retryAfterSeconds: "0",
  });
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.calls, 2);
  assert.deepEqual(outcome.sleeps, [0]);
});

test("padded ZENDESK_MAX_RETRIES value is honored", async () => {
  const outcome = await runScenario({
    env: { [RETRIES_ENV]: " 1 ", [DELAY_ENV]: undefined },
    rateLimitedCalls: 1,
    retryAfterSeconds: "1",
  });
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.calls, 2);
  assert.deepEqual(outcome.sleeps, [1000]);
});

test("padded ZENDESK_MAX_RETRY_DELAY_MS value is honored", async () => {
  const outcome = await runScenario({
    env: { [RETRIES_ENV]: undefined, [DELAY_ENV]: " 250 " },
    rateLimitedCalls: 1,
    retryAfterSeconds: "0.25",
  });
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.calls, 2);
  assert.deepEqual(outcome.sleeps, [250]);
});

test("boundary ZENDESK_MAX_RETRIES of 5 allows all five retries", async () => {
  const outcome = await runScenario({
    env: { [RETRIES_ENV]: "5", [DELAY_ENV]: undefined },
    rateLimitedCalls: 5,
    retryAfterSeconds: "1",
  });
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.calls, 6);
  assert.deepEqual(outcome.sleeps, [1000, 1000, 1000, 1000, 1000]);
});

test("boundary ZENDESK_MAX_RETRY_DELAY_MS of 60000 allows a 60s wait", async () => {
  const outcome = await runScenario({
    env: { [RETRIES_ENV]: undefined, [DELAY_ENV]: "60000" },
    rateLimitedCalls: 1,
    retryAfterSeconds: "60",
  });
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.calls, 2);
  assert.deepEqual(outcome.sleeps, [60000]);
});

test("out-of-range ZENDESK_MAX_RETRIES falls back to the default", async () => {
  // 6 exceeds the maximum of 5, so the default of 2 retries applies: the
  // third consecutive 429 is surfaced as an error after exactly two waits.
  const outcome = await runScenario({
    env: { [RETRIES_ENV]: "6", [DELAY_ENV]: undefined },
    rateLimitedCalls: 3,
    retryAfterSeconds: "1",
  });
  assert.ok(outcome.error instanceof ZendeskError);
  assert.equal(outcome.error.status, 429);
  assert.equal(outcome.calls, 3);
  assert.deepEqual(outcome.sleeps, [1000, 1000]);
});

test("non-integer ZENDESK_MAX_RETRIES falls back to the default", async () => {
  const outcome = await runScenario({
    env: { [RETRIES_ENV]: "two", [DELAY_ENV]: undefined },
    rateLimitedCalls: 3,
    retryAfterSeconds: "1",
  });
  assert.ok(outcome.error instanceof ZendeskError);
  assert.equal(outcome.error.status, 429);
  assert.equal(outcome.calls, 3);
  assert.deepEqual(outcome.sleeps, [1000, 1000]);
});

test("out-of-range ZENDESK_MAX_RETRY_DELAY_MS falls back to the default", async () => {
  // 60001 exceeds the 60s cap, so the default 10s cap applies and a 120s
  // Retry-After is rejected without retrying.
  const outcome = await runScenario({
    env: { [RETRIES_ENV]: undefined, [DELAY_ENV]: "60001" },
    rateLimitedCalls: 1,
    retryAfterSeconds: "120",
  });
  assert.ok(outcome.error instanceof ZendeskError);
  assert.equal(outcome.error.status, 429);
  assert.equal(outcome.calls, 1);
  assert.deepEqual(outcome.sleeps, []);
});

test("non-numeric ZENDESK_MAX_RETRY_DELAY_MS falls back to the default", async () => {
  const outcome = await runScenario({
    env: { [RETRIES_ENV]: undefined, [DELAY_ENV]: "soon" },
    rateLimitedCalls: 1,
    retryAfterSeconds: "2",
  });
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.calls, 2);
  assert.deepEqual(outcome.sleeps, [2000]);
});

test("documented defaults hold when both settings are unset", async () => {
  const outcome = await runScenario({
    env: { [RETRIES_ENV]: undefined, [DELAY_ENV]: undefined },
    rateLimitedCalls: DEFAULT_RETRIES,
    retryAfterSeconds: String(DEFAULT_DELAY_MS / 1000),
  });
  assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.result, { tickets: [] });
  assert.equal(outcome.calls, DEFAULT_RETRIES + 1);
  assert.deepEqual(
    outcome.sleeps,
    Array.from({ length: DEFAULT_RETRIES }, () => DEFAULT_DELAY_MS),
  );
});
