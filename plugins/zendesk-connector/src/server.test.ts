import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { INVALID_ENVELOPE_MESSAGE, ZendeskClient } from "./client.js";
import { createZendeskServer } from "./server.js";
import { PACKAGE_VERSION } from "./version.js";

test("publishes only tools enabled by the deployment allowlist", async () => {
  const original = process.env.ZENDESK_ALLOWED_TOOLS;
  process.env.ZENDESK_ALLOWED_TOOLS = "zendesk_status,zendesk_search_tickets";
  const server = createZendeskServer(
    new ZendeskClient(
      {
        baseUrl: "https://example.zendesk.com",
        mode: "access_token",
        accessToken: "oauth-access-token",
        tokenFile: "/unused/oauth.json",
        scope: "tickets:read",
      },
      async () => Response.json({ user: { id: 42 } }),
    ),
  );
  const client = new Client({ name: "policy-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ["zendesk_search_tickets", "zendesk_status"],
    );
  } finally {
    await client.close();
    await server.close();
    if (original === undefined) delete process.env.ZENDESK_ALLOWED_TOOLS;
    else process.env.ZENDESK_ALLOWED_TOOLS = original;
  }
});

test("read-only mode withholds the write tools over MCP", async (t) => {
  const original = process.env.ZENDESK_READ_ONLY;
  const originalTools = process.env.ZENDESK_ALLOWED_TOOLS;
  process.env.ZENDESK_READ_ONLY = "1";
  // An ambient allowlist would make the expected surface depend on the host.
  delete process.env.ZENDESK_ALLOWED_TOOLS;
  t.after(() => {
    if (original === undefined) delete process.env.ZENDESK_READ_ONLY;
    else process.env.ZENDESK_READ_ONLY = original;
    if (originalTools === undefined) delete process.env.ZENDESK_ALLOWED_TOOLS;
    else process.env.ZENDESK_ALLOWED_TOOLS = originalTools;
  });
  const server = createZendeskServer(
    new ZendeskClient(
      {
        baseUrl: "https://example.zendesk.com",
        mode: "access_token",
        accessToken: "oauth-access-token",
        tokenFile: "/unused/oauth.json",
        scope: "tickets:read",
      },
      async () => Response.json({ user: { id: 42 } }),
    ),
  );
  const client = new Client({ name: "policy-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        "zendesk_get_brand",
        "zendesk_get_organization",
        "zendesk_get_ticket",
        "zendesk_get_user",
        "zendesk_get_view",
        "zendesk_list_brands",
        "zendesk_list_groups",
        "zendesk_list_organizations",
        "zendesk_list_ticket_fields",
        "zendesk_list_ticket_forms",
        "zendesk_list_users",
        "zendesk_list_view_tickets",
        "zendesk_list_views",
        "zendesk_search_tickets",
        "zendesk_status",
      ],
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("publishes eighteen annotated tools and serves status over MCP", async (t) => {
  const originalReadOnly = process.env.ZENDESK_READ_ONLY;
  // An ambient read-only flag would publish fifteen tools instead of eighteen.
  delete process.env.ZENDESK_READ_ONLY;
  t.after(() => {
    if (originalReadOnly === undefined) delete process.env.ZENDESK_READ_ONLY;
    else process.env.ZENDESK_READ_ONLY = originalReadOnly;
  });
  const fetcher: typeof fetch = async (_input, init) => {
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer oauth-access-token",
    );
    return Response.json({ user: { id: 42, name: "Test Agent" } });
  };
  const zendesk = new ZendeskClient(
    {
      baseUrl: "https://example.zendesk.com",
      mode: "access_token",
      accessToken: "oauth-access-token",
      tokenFile: "/unused/oauth.json",
      scope: "tickets:read users:read",
    },
    fetcher,
  );
  const server = createZendeskServer(zendesk);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  try {
    assert.equal(client.getServerVersion()?.version, PACKAGE_VERSION);

    const tools = await client.listTools();
    assert.equal(tools.tools.length, 18);
    assert.equal(
      tools.tools.find((tool) => tool.name === "zendesk_get_ticket")
        ?.annotations?.readOnlyHint,
      true,
    );
    assert.equal(
      tools.tools.find((tool) => tool.name === "zendesk_create_ticket")
        ?.annotations?.readOnlyHint,
      false,
    );

    const result = await client.callTool({
      name: "zendesk_status",
      arguments: {},
    });
    assert.equal(result.isError, undefined);
    assert.ok(Array.isArray(result.content));
    const content = result.content[0] as { type: string; text?: string };
    assert.equal(content.type, "text");
    if (content.type === "text" && content.text) {
      const payload = JSON.parse(content.text);
      assert.equal(payload.user.name, "Test Agent");
      assert.equal(payload.oauth.mode, "access_token");
      // The token file's path is filesystem information the agent would only
      // repeat, so it is not part of the tool result.
      assert.equal("tokenFile" in payload.oauth, false);
      assert.ok(
        Object.keys(payload.oauth).every((key) =>
          ["mode", "scope", "refreshEnabled", "expiresAt"].includes(key),
        ),
      );
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("a refused token exchange puts no credential in the tool output", async (t) => {
  const originalReadOnly = process.env.ZENDESK_READ_ONLY;
  delete process.env.ZENDESK_READ_ONLY;
  t.after(() => {
    if (originalReadOnly === undefined) delete process.env.ZENDESK_READ_ONLY;
    else process.env.ZENDESK_READ_ONLY = originalReadOnly;
  });
  const echoedSecret = "invented-client-secret-value";
  const zendesk = new ZendeskClient(
    {
      baseUrl: "https://example.zendesk.com",
      mode: "client_credentials",
      clientId: "example-client-id",
      clientSecret: echoedSecret,
      tokenFile: "/unused/oauth.json",
      scope: "tickets:read",
    },
    async () =>
      new Response(
        JSON.stringify({
          error: "invalid_client",
          error_description: `client_secret ${echoedSecret} rejected`,
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
  );
  const server = createZendeskServer(zendesk);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  try {
    const result = await client.callTool({
      name: "zendesk_status",
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.ok(Array.isArray(result.content));
    const content = result.content[0] as { type: string; text?: string };
    const text = content.text ?? "";
    // The agent reads this text; a credential in it would reach the model.
    assert.ok(!text.includes(echoedSecret));
    const payload = JSON.parse(text);
    assert.equal(payload.status, 401);
    assert.deepEqual(payload.details.keys, ["error", "error_description"]);
    assert.equal(payload.details.error, "invalid_client");
  } finally {
    await client.close();
    await server.close();
  }
});

test("the write tools send the request bodies Zendesk expects", async (t) => {
  const originalReadOnly = process.env.ZENDESK_READ_ONLY;
  delete process.env.ZENDESK_READ_ONLY;
  t.after(() => {
    if (originalReadOnly === undefined) delete process.env.ZENDESK_READ_ONLY;
    else process.env.ZENDESK_READ_ONLY = originalReadOnly;
  });
  const requests: { url: string; method: string; body: unknown }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return Response.json({ ticket: { id: 7, subject: "Example subject" } });
  };
  const zendesk = new ZendeskClient(
    {
      baseUrl: "https://example.zendesk.com",
      mode: "access_token",
      accessToken: "oauth-access-token",
      tokenFile: "/unused/oauth.json",
      scope: "tickets:write",
    },
    fetcher,
  );
  const server = createZendeskServer(zendesk);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  try {
    const created = await client.callTool({
      name: "zendesk_create_ticket",
      arguments: {
        subject: "Example subject",
        comment: "Example body",
        requesterEmail: "person@example.com",
        priority: "high",
      },
    });
    assert.equal(created.isError, undefined);
    assert.deepEqual(requests.at(-1), {
      url: "https://example.zendesk.com/api/v2/tickets.json",
      method: "POST",
      body: {
        ticket: {
          subject: "Example subject",
          priority: "high",
          // The comment's visibility is sent, not left to a default.
          comment: { body: "Example body", public: true },
          requester: { email: "person@example.com", name: "person@example.com" },
        },
      },
    });

    const createdInternal = await client.callTool({
      name: "zendesk_create_ticket",
      arguments: {
        subject: "Example subject",
        comment: "Example body",
        public: false,
      },
    });
    assert.equal(createdInternal.isError, undefined);
    assert.deepEqual(requests.at(-1), {
      url: "https://example.zendesk.com/api/v2/tickets.json",
      method: "POST",
      body: {
        ticket: {
          subject: "Example subject",
          comment: { body: "Example body", public: false },
        },
      },
    });

    const updated = await client.callTool({
      name: "zendesk_update_ticket",
      arguments: { ticketId: 7, status: "solved" },
    });
    assert.equal(updated.isError, undefined);
    assert.deepEqual(requests.at(-1), {
      url: "https://example.zendesk.com/api/v2/tickets/7.json",
      method: "PUT",
      body: { ticket: { status: "solved" } },
    });

    const commented = await client.callTool({
      name: "zendesk_add_ticket_comment",
      arguments: { ticketId: 7, body: "Example note" },
    });
    assert.equal(commented.isError, undefined);
    assert.deepEqual(requests.at(-1), {
      url: "https://example.zendesk.com/api/v2/tickets/7.json",
      method: "PUT",
      // An omitted "public" flag must stay an internal note.
      body: { ticket: { comment: { body: "Example note", public: false } } },
    });

    const empty = await client.callTool({
      name: "zendesk_update_ticket",
      arguments: { ticketId: 7 },
    });
    assert.equal(empty.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});

/** Connects an in-memory MCP client to a server backed by the given fetcher. */
async function connectServer(fetcher: typeof fetch) {
  const zendesk = new ZendeskClient(
    {
      baseUrl: "https://example.zendesk.com",
      mode: "access_token",
      accessToken: "oauth-access-token",
      tokenFile: "/unused/oauth.json",
      scope: "tickets:write",
    },
    fetcher,
  );
  const server = createZendeskServer(zendesk);
  const client = new Client({ name: "envelope-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return { client, server };
}

/** The error payload every envelope-validation failure must produce. */
function envelopeError(result: Awaited<ReturnType<Client["callTool"]>>) {
  assert.equal(result.isError, true);
  assert.ok(Array.isArray(result.content));
  const content = result.content[0];
  assert.ok(content && content.type === "text");
  assert.deepEqual(JSON.parse(content.text), {
    error: INVALID_ENVELOPE_MESSAGE,
  });
}

const newlyCoveredTools: {
  name: string;
  call: { name: string; arguments: Record<string, unknown> };
  fetcher: typeof fetch;
}[] = [
  {
    name: "zendesk_status rejects a non-object user",
    call: { name: "zendesk_status", arguments: {} },
    fetcher: async () => Response.json({ user: "not-an-object" }),
  },
  {
    name: "zendesk_search_tickets rejects a non-array results page",
    call: {
      name: "zendesk_search_tickets",
      arguments: { query: "type:ticket" },
    },
    fetcher: async () => Response.json({ results: { id: 1 } }),
  },
  {
    name: "zendesk_get_ticket rejects a missing ticket object",
    call: { name: "zendesk_get_ticket", arguments: { ticketId: 9 } },
    fetcher: async () => Response.json({ users: [] }),
  },
  {
    name: "zendesk_get_user rejects a non-object user",
    call: { name: "zendesk_get_user", arguments: { userId: 5 } },
    fetcher: async () => Response.json({ user: "not-an-object" }),
  },
  {
    name: "zendesk_get_brand rejects a non-object brand",
    call: { name: "zendesk_get_brand", arguments: { brandId: 5 } },
    fetcher: async () => Response.json({ brand: "not-an-object" }),
  },
  {
    name: "zendesk_get_organization rejects a non-object organization",
    call: { name: "zendesk_get_organization", arguments: { organizationId: 5 } },
    fetcher: async () => Response.json({ organization: "not-an-object" }),
  },
  {
    name: "zendesk_get_view rejects a non-object view",
    call: { name: "zendesk_get_view", arguments: { viewId: 5 } },
    fetcher: async () => Response.json({ view: "not-an-object" }),
  },
  {
    name: "zendesk_get_ticket rejects a malformed comments page",
    call: {
      name: "zendesk_get_ticket",
      arguments: { ticketId: 9, includeComments: true },
    },
    fetcher: async (input) =>
      String(input).includes("/comments.json")
        ? Response.json({ comments: "not-an-array" })
        : Response.json({ ticket: { id: 9 }, users: [] }),
  },
  {
    name: "zendesk_create_ticket rejects a non-object ticket",
    call: {
      name: "zendesk_create_ticket",
      arguments: { subject: "Example subject", comment: "Example body" },
    },
    fetcher: async () => Response.json({ ticket: [7] }),
  },
  {
    name: "zendesk_update_ticket rejects a null ticket",
    call: {
      name: "zendesk_update_ticket",
      arguments: { ticketId: 7, status: "solved" },
    },
    fetcher: async () => Response.json({ ticket: null }),
  },
  {
    name: "zendesk_add_ticket_comment rejects a scalar ticket",
    call: {
      name: "zendesk_add_ticket_comment",
      arguments: { ticketId: 7, body: "Example note" },
    },
    fetcher: async () => Response.json({ ticket: "oops" }),
  },
];

for (const { name, call, fetcher } of newlyCoveredTools) {
  test(name, async (t) => {
    const originalReadOnly = process.env.ZENDESK_READ_ONLY;
    delete process.env.ZENDESK_READ_ONLY;
    t.after(() => {
      if (originalReadOnly === undefined) delete process.env.ZENDESK_READ_ONLY;
      else process.env.ZENDESK_READ_ONLY = originalReadOnly;
    });
    const { client, server } = await connectServer(fetcher);

    try {
      envelopeError(await client.callTool(call));
    } finally {
      await client.close();
      await server.close();
    }
  });
}

test("a malformed successful write is sent once, not retried", async (t) => {
  const originalReadOnly = process.env.ZENDESK_READ_ONLY;
  delete process.env.ZENDESK_READ_ONLY;
  t.after(() => {
    if (originalReadOnly === undefined) delete process.env.ZENDESK_READ_ONLY;
    else process.env.ZENDESK_READ_ONLY = originalReadOnly;
  });
  let calls = 0;
  const { client, server } = await connectServer(async () => {
    calls += 1;
    // A successful status that carries no usable ticket object. The write
    // may already have gone through upstream, so the client must not retry.
    return Response.json({ audit: { via: "api" } });
  });

  try {
    envelopeError(
      await client.callTool({
        name: "zendesk_create_ticket",
        arguments: { subject: "Example subject", comment: "Example body" },
      }),
    );
    assert.equal(calls, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("get ticket keeps side-loads and unknown fields from both responses", async (t) => {
  const originalReadOnly = process.env.ZENDESK_READ_ONLY;
  delete process.env.ZENDESK_READ_ONLY;
  t.after(() => {
    if (originalReadOnly === undefined) delete process.env.ZENDESK_READ_ONLY;
    else process.env.ZENDESK_READ_ONLY = originalReadOnly;
  });
  const { client, server } = await connectServer(async (input) =>
    String(input).includes("/comments.json")
      ? Response.json({
          comments: [
            { id: 3, body: "Example note", future_comment_field: 1 },
          ],
          users: [{ id: 5, name: "Example Agent" }],
          next_page: null,
          unknown_comments_field: "kept",
        })
      : Response.json({
          ticket: { id: 9, subject: "Example subject", future_ticket_field: 2 },
          users: [{ id: 5, name: "Example Agent" }],
          organizations: [{ id: 6, name: "Example Org" }],
          unknown_ticket_field: "kept",
        }),
  );

  try {
    const result = await client.callTool({
      name: "zendesk_get_ticket",
      arguments: { ticketId: 9 },
    });
    assert.equal(result.isError, undefined);
    assert.ok(Array.isArray(result.content));
    const content = result.content[0];
    assert.ok(content && content.type === "text");
    const payload = JSON.parse(content.text);
    // Every Zendesk and unknown field survives validation untouched.
    assert.equal(payload.ticket.future_ticket_field, 2);
    assert.equal(payload.unknown_ticket_field, "kept");
    assert.deepEqual(payload.organizations, [{ id: 6, name: "Example Org" }]);
    assert.deepEqual(payload.comments, [
      { id: 3, body: "Example note", future_comment_field: 1 },
    ]);
    assert.equal(payload.comments[0].future_comment_field, 1);
    assert.deepEqual(payload.commentUsers, [{ id: 5, name: "Example Agent" }]);
    assert.equal(payload.agent_url, "https://example.zendesk.com/agent/tickets/9");
  } finally {
    await client.close();
    await server.close();
  }
});
