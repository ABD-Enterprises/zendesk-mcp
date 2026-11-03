import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  INVALID_ENVELOPE_MESSAGE,
  ZendeskClient,
  ZendeskError,
} from "./client.js";
import { createZendeskServer } from "./server.js";
import type { ZendeskConfig } from "./auth.js";
import { PACKAGE_VERSION } from "./version.js";

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

test("retries a rate-limited request at once when the server names no wait", async () => {
  // No header names a wait, so there is none. The example environment file
  // says so, and the wait is read from the same chain.
  const sleeps: number[] = [];
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return Response.json({ error: "rate_limited" }, { status: 429 });
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
    10_000,
  );

  assert.deepEqual(await client.request("/tickets.json"), { tickets: [] });
  assert.deepEqual(sleeps, [0]);
  assert.equal(calls, 2);
});

test("waits one second when the rate-limit reset header is not a number", async () => {
  // A reset header that cannot be read as a number gives one second. The
  // example environment file says so, and the wait is read from the same
  // chain.
  const sleeps: number[] = [];
  const fetcher: typeof fetch = async () =>
    Response.json(
      { error: "rate_limited" },
      { status: 429, headers: { "ratelimit-reset": "soon" } },
    );
  const client = new ZendeskClient(
    accessTokenConfig(),
    fetcher,
    async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    2,
    10_000,
  );

  await assert.rejects(() => client.request("/tickets.json"));
  assert.deepEqual(sleeps, [1000, 1000]);
});

test("reads the retry limit the way the example environment file says", async () => {
  // Whitespace around a number is ignored, a value that is not an integer
  // inside the allowed range falls back to the default of two, and a value of
  // only whitespace counts as 0 rather than as unset.
  const previous = process.env.ZENDESK_MAX_RETRIES;
  try {
    process.env.ZENDESK_MAX_RETRIES = " 3 ";
    assert.equal(await rateLimitedCalls(), 4);

    process.env.ZENDESK_MAX_RETRIES = "abc";
    assert.equal(await rateLimitedCalls(), 3);

    // Six is outside the range of the count, so the default of two is used.
    process.env.ZENDESK_MAX_RETRIES = "6";
    assert.equal(await rateLimitedCalls(), 3);

    process.env.ZENDESK_MAX_RETRIES = " ";
    assert.equal(await rateLimitedCalls(), 1);
  } finally {
    if (previous === undefined) delete process.env.ZENDESK_MAX_RETRIES;
    else process.env.ZENDESK_MAX_RETRIES = previous;
  }
});

test("reads the longest wait the way the example environment file says", async () => {
  // The wait of a 429 is thirty seconds. That is longer than the default of
  // ten thousand milliseconds, so the request is not retried; the maximum is
  // sixty thousand, and a wait inside it is slept out.
  const previous = process.env.ZENDESK_MAX_RETRY_DELAY_MS;
  const previousCount = process.env.ZENDESK_MAX_RETRIES;
  try {
    // The count of retries is read from the environment as well, and the
    // sends below assume its default of two: an operator who exports it must
    // not change what the suite measures.
    delete process.env.ZENDESK_MAX_RETRIES;
    delete process.env.ZENDESK_MAX_RETRY_DELAY_MS;
    assert.equal(await rateLimitedCalls({ "retry-after": "30" }), 1);

    process.env.ZENDESK_MAX_RETRY_DELAY_MS = "60000";
    assert.equal(await rateLimitedCalls({ "retry-after": "30" }), 3);

    // Sixty thousand and one is outside the range, so the default of ten
    // thousand is used and the wait is too long again.
    process.env.ZENDESK_MAX_RETRY_DELAY_MS = "60001";
    assert.equal(await rateLimitedCalls({ "retry-after": "30" }), 1);
  } finally {
    if (previous === undefined) delete process.env.ZENDESK_MAX_RETRY_DELAY_MS;
    else process.env.ZENDESK_MAX_RETRY_DELAY_MS = previous;
    if (previousCount === undefined) delete process.env.ZENDESK_MAX_RETRIES;
    else process.env.ZENDESK_MAX_RETRIES = previousCount;
  }
});

/** The number of times a rate-limited request is sent, with the limits read from the environment. */
async function rateLimitedCalls(headers: Record<string, string> = {}): Promise<number> {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return Response.json({ error: "rate_limited" }, { status: 429, headers });
  };
  const client = new ZendeskClient(
    accessTokenConfig(),
    fetcher,
    async () => undefined,
  );

  await assert.rejects(() => client.request("/tickets.json"));
  return calls;
}

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

test("sends the connector version in the User-Agent header", async () => {
  let userAgent: string | null = null;
  const fetcher: typeof fetch = async (_input, init) => {
    userAgent = new Headers(init?.headers).get("user-agent");
    return Response.json({ tickets: [] });
  };
  const client = new ZendeskClient(accessTokenConfig(), fetcher);

  await client.request("/tickets.json");
  assert.equal(userAgent, `abd-enterprises-zendesk-mcp/${PACKAGE_VERSION}`);
});

test("accepts a valid collection envelope and preserves unknown fields", async () => {
  const envelope = {
    brands: [
      { id: 1, name: "Example Brand", future_flag: { nested: [1, 2, 3] } },
      { url: "https://example.zendesk.com/api/v2/brands/2.json" },
    ],
    count: 42,
    next_page: null,
    unknown_envelope_field: "kept",
  };
  const client = new ZendeskClient(
    accessTokenConfig(),
    async () => Response.json(envelope),
  );

  // The very same values come back: validation must not strip, default
  // or rewrite unknown record or envelope fields.
  assert.deepEqual(await client.request("/brands.json", { collection: "brands" }), envelope);
});

test("request callers without a collection option stay unvalidated", async () => {
  // Existing request<T> callers keep the previous behavior: no envelope
  // check runs unless one is asked for.
  const client = new ZendeskClient(
    accessTokenConfig(),
    async () => Response.json({}),
  );

  assert.deepEqual(await client.request("/brands.json"), {});
});

test("all six list tools reject malformed collection envelopes", async (t) => {
  const originalAllowedTools = process.env.ZENDESK_ALLOWED_TOOLS;
  const toolNames = [
    "zendesk_list_brands",
    "zendesk_list_groups",
    "zendesk_list_users",
    "zendesk_list_organizations",
    "zendesk_list_ticket_fields",
    "zendesk_list_ticket_forms",
  ];
  process.env.ZENDESK_ALLOWED_TOOLS = toolNames.join(",");
  t.after(() => {
    if (originalAllowedTools === undefined) {
      delete process.env.ZENDESK_ALLOWED_TOOLS;
    } else {
      process.env.ZENDESK_ALLOWED_TOOLS = originalAllowedTools;
    }
  });

  const fetcher: typeof fetch = async (input) => {
    const endpoint = new URL(String(input)).pathname.split("/").at(-1);
    const collection = endpoint?.replace(/\.json$/, "");
    return Response.json({ [collection ?? "unknown"]: "not-an-array" });
  };
  const zendesk = new ZendeskClient(accessTokenConfig(), fetcher);
  const server = createZendeskServer(zendesk);
  const client = new Client({ name: "collection-validation-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  try {
    for (const name of toolNames) {
      const result = await client.callTool({ name, arguments: {} });
      assert.equal(result.isError, true, `${name} should reject the malformed envelope`);
      assert.ok(Array.isArray(result.content));
      const firstContent = result.content[0];
      assert.ok(firstContent && firstContent.type === "text");
      assert.deepEqual(JSON.parse(firstContent.text), {
        error: INVALID_ENVELOPE_MESSAGE,
      });
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("accepts a valid object envelope and preserves unknown fields", async () => {
  const envelope = {
    ticket: { id: 7, subject: "Example subject", future_flag: [1, 2] },
    audit: { via: "api" },
    unknown_envelope_field: { nested: true },
  };
  const client = new ZendeskClient(
    accessTokenConfig(),
    async () => Response.json(envelope),
  );

  // The very same values come back: validation must not strip, default
  // or rewrite unknown record or envelope fields.
  assert.deepEqual(
    await client.request("/tickets.json", { object: "ticket" }),
    envelope,
  );
});

test("accepts an empty object record and an empty collection array", async () => {
  const client = new ZendeskClient(
    accessTokenConfig(),
    async () => Response.json({ ticket: {} }),
  );

  assert.deepEqual(
    await client.request("/tickets.json", { object: "ticket" }),
    { ticket: {} },
  );

  const emptyCollection = new ZendeskClient(
    accessTokenConfig(),
    async () => Response.json({ results: [] }),
  );
  assert.deepEqual(
    await emptyCollection.request("/search.json", { collection: "results" }),
    { results: [] },
  );
});

const malformedObjectEnvelopes: { name: string; body: unknown }[] = [
  { name: "a missing object key", body: { count: 1 } },
  { name: "a scalar object", body: { ticket: "oops" } },
  { name: "a null object", body: { ticket: null } },
  { name: "an array object", body: { ticket: [{ id: 1 }] } },
  { name: "an array instead of an object envelope", body: [{ ticket: {} }] },
  { name: "a string object-envelope body", body: "not-json-object" },
];

for (const { name, body } of malformedObjectEnvelopes) {
  test(`rejects ${name} with a fixed error`, async () => {
    const client = new ZendeskClient(
      accessTokenConfig(),
      async () => Response.json(body),
    );

    await assert.rejects(
      () => client.request("/tickets.json", { object: "ticket" }),
      (error: unknown) => {
        assert.ok(error instanceof ZendeskError);
        assert.equal(error.message, INVALID_ENVELOPE_MESSAGE);
        // No status, details, Zod issues or raw response values leak.
        assert.equal(error.status, undefined);
        assert.equal(error.details, undefined);
        assert.ok(!("issues" in error));
        return true;
      },
    );
  });
}

test("rejects an empty successful body when an object is required", async () => {
  const client = new ZendeskClient(
    accessTokenConfig(),
    async () => new Response("", { status: 200 }),
  );

  await assert.rejects(
    () => client.request("/users/me.json", { object: "user" }),
    (error: unknown) => {
      assert.ok(error instanceof ZendeskError);
      assert.equal(error.message, INVALID_ENVELOPE_MESSAGE);
      return true;
    },
  );
});

const malformedEnvelopes: { name: string; body: unknown }[] = [
  { name: "an array instead of an envelope", body: [{ brands: [] }] },
  { name: "a string body", body: "not-json-object" },
  { name: "a missing collection key", body: { count: 1 } },
  { name: "a scalar collection", body: { brands: "oops" } },
  { name: "a null collection", body: { brands: null } },
  { name: "an object collection", body: { brands: { id: 1 } } },
  { name: "a numeric record", body: { brands: [7] } },
  { name: "a null record", body: { brands: [null] } },
  { name: "an array record", body: { brands: [[1, 2]] } },
  { name: "a string record", body: { brands: ["brand"] } },
];

for (const { name, body } of malformedEnvelopes) {
  test(`rejects ${name} with a fixed error`, async () => {
    const client = new ZendeskClient(
      accessTokenConfig(),
      async () => Response.json(body),
    );

    await assert.rejects(
      () => client.request("/brands.json", { collection: "brands" }),
      (error: unknown) => {
        assert.ok(error instanceof ZendeskError);
        assert.equal(error.message, INVALID_ENVELOPE_MESSAGE);
        // No status, details, Zod issues or raw response values leak.
        assert.equal(error.status, undefined);
        assert.equal(error.details, undefined);
        assert.ok(!("issues" in error));
        return true;
      },
    );
  });
}

test("rejects an empty successful body when a collection is required", async () => {
  const client = new ZendeskClient(
    accessTokenConfig(),
    async () => new Response("", { status: 200 }),
  );

  await assert.rejects(
    () => client.request("/brands.json", { collection: "brands" }),
    (error: unknown) => {
      assert.ok(error instanceof ZendeskError);
      assert.equal(error.message, INVALID_ENVELOPE_MESSAGE);
      return true;
    },
  );
});

test("keeps the HTTP error when an error response fails envelope validation", async () => {
  // Envelope validation runs only after HTTP-error handling, so a failing
  // status keeps its own error shape even when the body would also fail
  // the envelope check.
  const client = new ZendeskClient(
    accessTokenConfig(),
    async () =>
      Response.json(
        { error: "boom" },
        { status: 500, statusText: "Internal Server Error" },
      ),
  );

  await assert.rejects(
    () => client.request("/brands.json", { collection: "brands" }),
    (error: unknown) => {
      assert.ok(error instanceof ZendeskError);
      assert.equal(error.status, 500);
      assert.equal(
        error.message,
        "Zendesk API request failed: HTTP 500 Internal Server Error",
      );
      return true;
    },
  );
});

test("validates only the successful response after a retry", async () => {
  let calls = 0;
  const client = new ZendeskClient(
    accessTokenConfig(),
    async () => {
      calls += 1;
      return calls === 1
        ? Response.json({ error: "rate_limited" }, { status: 429 })
        : Response.json({ brands: "not-an-array" });
    },
    async () => undefined,
    2,
    10_000,
  );

  await assert.rejects(
    () => client.request("/brands.json", { collection: "brands" }),
    (error: unknown) => {
      assert.ok(error instanceof ZendeskError);
      assert.equal(error.message, INVALID_ENVELOPE_MESSAGE);
      return true;
    },
  );
  assert.equal(calls, 2);
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
