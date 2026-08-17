import assert from "node:assert/strict";
import { test } from "node:test";
import { ZendeskClient, ZendeskError } from "./client.js";
import type { ZendeskConfig } from "./auth.js";

test("retries a rate-limited request after Retry-After", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const fetcher: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return Response.json(
        { error: "rate_limited" },
        { status: 429, headers: { "retry-after": "0.001" } },
      );
    }
    return Response.json({ tickets: [] });
  };
  const client = new ZendeskClient(
    accessTokenConfig(),
    fetcher,
    async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    2,
    100,
  );

  assert.deepEqual(await client.request("/tickets.json"), { tickets: [] });
  assert.deepEqual(sleeps, [1]);
  assert.equal(calls, 2);
});

test("returns rate-limit metadata when a retry would wait too long", async () => {
  const fetcher: typeof fetch = async () =>
    Response.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: {
          "retry-after": "120",
          "ratelimit-remaining": "0",
          "ratelimit-reset": "120",
        },
      },
    );
  const client = new ZendeskClient(
    accessTokenConfig(),
    fetcher,
    async () => undefined,
    2,
    10_000,
  );

  await assert.rejects(
    () => client.request("/tickets.json"),
    (error: unknown) => {
      assert.ok(error instanceof ZendeskError);
      assert.equal(error.status, 429);
      assert.deepEqual(error.details, {
        response: { error: "rate_limited" },
        retryAfterSeconds: 120,
        rateLimitRemaining: "0",
        rateLimitResetSeconds: "120",
      });
      return true;
    },
  );
});

test("refreshes OAuth once after an unauthorized API response", async () => {
  let tokenCalls = 0;
  const apiTokens: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/oauth/tokens")) {
      tokenCalls += 1;
      return Response.json({
        access_token: `oauth-${tokenCalls}`,
        expires_in: 3600,
      });
    }
    apiTokens.push(new Headers(init?.headers).get("authorization") ?? "");
    return apiTokens.length === 1
      ? Response.json({ error: "expired" }, { status: 401 })
      : Response.json({ user: { id: 1 } });
  };
  const client = new ZendeskClient(
    {
      ...accessTokenConfig(),
      mode: "client_credentials",
      accessToken: undefined,
      clientId: "client-id",
      clientSecret: "client-secret",
    },
    fetcher,
  );

  assert.deepEqual(await client.request("/users/me.json"), { user: { id: 1 } });
  assert.equal(tokenCalls, 2);
  assert.deepEqual(apiTokens, ["Bearer oauth-1", "Bearer oauth-2"]);
});

function accessTokenConfig(): ZendeskConfig {
  return {
    baseUrl: "https://example.zendesk.com",
    mode: "access_token",
    accessToken: "oauth-access-token",
    tokenFile: "/unused/oauth.json",
    scope: "tickets:read",
  };
}
