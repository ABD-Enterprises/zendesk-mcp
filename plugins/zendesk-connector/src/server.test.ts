import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ZendeskClient } from "./client.js";
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
        "zendesk_get_ticket",
        "zendesk_list_brands",
        "zendesk_list_groups",
        "zendesk_list_organizations",
        "zendesk_list_ticket_fields",
        "zendesk_list_ticket_forms",
        "zendesk_list_users",
        "zendesk_search_tickets",
        "zendesk_status",
      ],
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("publishes twelve annotated tools and serves status over MCP", async (t) => {
  const originalReadOnly = process.env.ZENDESK_READ_ONLY;
  // An ambient read-only flag would publish nine tools instead of twelve.
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
    assert.equal(tools.tools.length, 12);
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
