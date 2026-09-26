import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ZendeskAuthError } from "./auth.js";
import { audit, redact } from "./audit.js";
import { ZendeskClient, ZendeskError } from "./client.js";
import { assertToolAllowed, configuredTools, type ZendeskToolName } from "./policy.js";

const VERSION = "0.4.0";
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

type JsonObject = Record<string, unknown>;

export function createZendeskServer(client = new ZendeskClient()): McpServer {
  const allowedTools = configuredTools();
  let actorId: number | string | undefined;
  const server = new McpServer(
    { name: "zendesk-mcp", version: VERSION },
    {
      instructions:
        "Use read tools to inspect Zendesk before making changes. Treat create, update, and comment tools as external writes. Internal notes default to non-public. Never expose OAuth credentials or raw token files in tool output.",
    },
  );

  const guard = (tool: ZendeskToolName) => {
    assertToolAllowed(allowedTools, tool);
  };

  allowedTools.has("zendesk_status") && server.registerTool(
    "zendesk_status",
    {
      title: "Check Zendesk connection",
      description: "Check OAuth configuration and return the authenticated user.",
      inputSchema: z.object({}),
      annotations: readAnnotations,
    },
    async () =>
      runTool("zendesk_status", "read", actorId, async () => {
        guard("zendesk_status");
        const response = await client.request<{ user: JsonObject }>(
          "/users/me.json",
        );
        const authenticatedId = response.user.id;
        actorId =
          typeof authenticatedId === "number" || typeof authenticatedId === "string"
            ? authenticatedId
            : undefined;
        return {
          configured: true,
          baseUrl: client.baseUrl,
          oauth: client.auth.status(),
          user: response.user,
        };
      }),
  );

  allowedTools.has("zendesk_search_tickets") && server.registerTool(
    "zendesk_search_tickets",
    {
      title: "Search Zendesk tickets",
      description:
        "Search Zendesk tickets with Zendesk search syntax. Example: type:ticket status<solved priority:high.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe("Zendesk search query. Include type:ticket unless searching broadly."),
        page: z.number().int().positive().default(1),
        perPage: z
          .number()
          .int()
          .positive()
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE),
      }),
      annotations: readAnnotations,
    },
    async ({ query, page, perPage }) =>
      runTool("zendesk_search_tickets", "read", actorId, async () => {
        guard("zendesk_search_tickets");
        const response = await client.request<{
          results: JsonObject[];
          count?: number;
          next_page?: string | null;
        }>("/search.json", {
          query: { query, page, per_page: perPage },
        });

        return {
          count: response.count,
          page,
          perPage,
          nextPageAvailable: Boolean(response.next_page),
          results: response.results.map((ticket) => {
            const id = ticketId(ticket);
            return {
              ...ticket,
              agent_url: id ? ticketUrl(client, id) : undefined,
            };
          }),
        };
      }),
  );

  allowedTools.has("zendesk_get_ticket") && server.registerTool(
    "zendesk_get_ticket",
    {
      title: "Get Zendesk ticket",
      description:
        "Get a Zendesk ticket with requester, assignee, organization, and recent comments.",
      inputSchema: z.object({
        ticketId: z.number().int().positive(),
        includeComments: z.boolean().default(true),
      }),
      annotations: readAnnotations,
    },
    async ({ ticketId: id, includeComments }) =>
      runTool("zendesk_get_ticket", "read", actorId, async () => {
        guard("zendesk_get_ticket");
        const ticketResponse = await client.request<{
          ticket: JsonObject;
          users?: JsonObject[];
          organizations?: JsonObject[];
        }>(`/tickets/${id}.json`, {
          query: { include: "users,organizations" },
        });

        if (!includeComments) {
          return { ...ticketResponse, agent_url: ticketUrl(client, id) };
        }

        const commentsResponse = await client.request<{
          comments: JsonObject[];
          users?: JsonObject[];
          next_page?: string | null;
        }>(`/tickets/${id}/comments.json`);

        return {
          ...ticketResponse,
          comments: commentsResponse.comments,
          commentUsers: commentsResponse.users,
          commentsTruncated: Boolean(commentsResponse.next_page),
          agent_url: ticketUrl(client, id),
        };
      }),
  );

  allowedTools.has("zendesk_create_ticket") && server.registerTool(
    "zendesk_create_ticket",
    {
      title: "Create Zendesk ticket",
      description: "Create a Zendesk ticket.",
      inputSchema: z.object({
        subject: z.string().min(1),
        comment: z.string().min(1),
        requesterEmail: z.string().email().optional(),
        requesterName: z.string().optional(),
        priority: TicketPriority.optional(),
        status: TicketStatus.optional(),
        type: TicketType.optional(),
        tags: z.array(z.string()).optional(),
      }),
      annotations: writeAnnotations(false),
    },
    async (input) =>
      runTool("zendesk_create_ticket", "write", actorId, async () => {
        guard("zendesk_create_ticket");
        const response = await client.request<{ ticket: JsonObject }>(
          "/tickets.json",
          { method: "POST", body: buildTicketPayload(input) },
        );
        const id = ticketId(response.ticket);
        return {
          ...response,
          agent_url: id ? ticketUrl(client, id) : undefined,
        };
      }),
  );

  allowedTools.has("zendesk_update_ticket") && server.registerTool(
    "zendesk_update_ticket",
    {
      title: "Update Zendesk ticket",
      description:
        "Update common Zendesk ticket fields. Provide only fields that should change.",
      inputSchema: z.object({
        ticketId: z.number().int().positive(),
        subject: z.string().min(1).optional(),
        priority: TicketPriority.optional(),
        status: TicketStatus.optional(),
        type: TicketType.optional(),
        tags: z.array(z.string()).optional(),
      }),
      annotations: writeAnnotations(true),
    },
    async ({ ticketId: id, ...updates }) =>
      runTool("zendesk_update_ticket", "write", actorId, async () => {
        guard("zendesk_update_ticket");
        if (Object.values(updates).every((value) => value === undefined)) {
          throw new ZendeskError("No update fields were provided.");
        }
        const response = await client.request<{ ticket: JsonObject }>(
          `/tickets/${id}.json`,
          { method: "PUT", body: buildTicketPayload(updates) },
        );
        return { ...response, agent_url: ticketUrl(client, id) };
      }),
  );

  allowedTools.has("zendesk_add_ticket_comment") && server.registerTool(
    "zendesk_add_ticket_comment",
    {
      title: "Comment on Zendesk ticket",
      description: "Add a public reply or internal note to a Zendesk ticket.",
      inputSchema: z.object({
        ticketId: z.number().int().positive(),
        body: z.string().min(1),
        public: z
          .boolean()
          .default(false)
          .describe("False creates an internal note."),
      }),
      annotations: writeAnnotations(false),
    },
    async ({ ticketId: id, body, public: isPublic }) =>
      runTool("zendesk_add_ticket_comment", "write", actorId, async () => {
        guard("zendesk_add_ticket_comment");
        const response = await client.request<{ ticket: JsonObject }>(
          `/tickets/${id}.json`,
          {
            method: "PUT",
            body: { ticket: { comment: { body, public: isPublic } } },
          },
        );
        return { ...response, agent_url: ticketUrl(client, id) };
      }),
  );

  return server;
}

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

function writeAnnotations(idempotent: boolean) {
  return {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: idempotent,
    openWorldHint: true,
  } as const;
}

function ticketUrl(client: ZendeskClient, id: number | string): string {
  return `${client.baseUrl}/agent/tickets/${id}`;
}

function ticketId(ticket: JsonObject): number | string | undefined {
  return typeof ticket.id === "number" || typeof ticket.id === "string"
    ? ticket.id
    : undefined;
}

function buildTicketPayload(input: {
  subject?: string;
  comment?: string;
  requesterEmail?: string;
  requesterName?: string;
  priority?: string;
  status?: string;
  type?: string;
  tags?: string[];
}) {
  const ticket: JsonObject = {};
  if (input.subject) ticket.subject = input.subject;
  if (input.priority) ticket.priority = input.priority;
  if (input.status) ticket.status = input.status;
  if (input.type) ticket.type = input.type;
  if (input.tags) ticket.tags = input.tags;
  if (input.comment) ticket.comment = { body: input.comment };
  if (input.requesterEmail) {
    ticket.requester = {
      email: input.requesterEmail,
      name: input.requesterName ?? input.requesterEmail,
    };
  }
  return { ticket };
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(error: unknown) {
  const payload =
    error instanceof ZendeskError || error instanceof ZendeskAuthError
      ? { error: error.message, status: error.status, details: error.details }
      : { error: error instanceof Error ? error.message : String(error) };
  const safePayload = redact(payload);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(safePayload, null, 2) }],
  };
}

async function runTool(
  tool: ZendeskToolName,
  operation: "read" | "write",
  actorId: number | string | undefined,
  action: () => Promise<unknown>,
) {
  try {
    const value = await action();
    audit({ tool, operation, outcome: "success", actorId });
    return toolResult(value);
  } catch (error) {
    audit({
      tool,
      operation,
      outcome: "error",
      actorId,
      status: error instanceof ZendeskError || error instanceof ZendeskAuthError ? error.status : undefined,
    });
    return errorResult(error);
  }
}

const TicketPriority = z.enum(["urgent", "high", "normal", "low"]);
const TicketStatus = z.enum([
  "new",
  "open",
  "pending",
  "hold",
  "solved",
  "closed",
]);
const TicketType = z.enum(["problem", "incident", "question", "task"]);
