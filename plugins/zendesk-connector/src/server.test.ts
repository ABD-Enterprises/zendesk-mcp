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
    }
  } finally {
    await client.close();
    await server.close();
  }
});
