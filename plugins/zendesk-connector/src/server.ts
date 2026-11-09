import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ZendeskClient } from "./client.js";
import { configuredTools } from "./policy.js";
import { PACKAGE_VERSION } from "./version.js";
import { createRegistrar, type ToolContext } from "./tools/register.js";
import { registerDirectoryTools } from "./tools/directory.js";
import { registerStatusTool } from "./tools/status.js";
import { registerTicketTools } from "./tools/tickets.js";
import { registerTicketMetadataTools } from "./tools/ticketMetadata.js";
import { registerViewTools } from "./tools/views.js";

export function createZendeskServer(client = new ZendeskClient()): McpServer {
  const allowedTools = configuredTools();
  let actorId: number | string | undefined;
  const server = new McpServer(
    { name: "zendesk-mcp", version: PACKAGE_VERSION },
    {
      instructions:
        "Use read tools to inspect Zendesk before making changes. Treat create, update, and comment tools as external writes. A comment added to an existing ticket is an internal note unless the call says otherwise; the first comment of a new ticket is public unless the call says otherwise. Never expose OAuth credentials or raw token files in tool output.",
    },
  );

  const ctx: ToolContext = {
    client,
    allowedTools,
    getActorId: () => actorId,
    setActorId: (id) => {
      actorId = id;
    },
  };
  const register = createRegistrar(server, ctx);

  registerStatusTool(register, ctx);
  registerTicketTools(register, ctx);
  registerDirectoryTools(register, ctx);
  registerTicketMetadataTools(register, ctx);
  registerViewTools(register, ctx);

  return server;
}
