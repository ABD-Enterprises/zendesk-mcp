import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ZendeskClient } from "./client.js";
import { createZendeskServer } from "./server.js";

test("publishes six annotated tools and serves status over MCP", async () => {
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
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 6);
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
