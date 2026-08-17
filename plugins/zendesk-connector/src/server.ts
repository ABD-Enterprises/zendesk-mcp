import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ZendeskAuthError } from "./auth.js";
import { ZendeskClient, ZendeskError } from "./client.js";

const VERSION = "0.3.0";
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

type JsonObject = Record<string, unknown>;

export function createZendeskServer(client = new ZendeskClient()): McpServer {
  const server = new McpServer(
    { name: "zendesk-mcp", version: VERSION },
    {
      instructions:
        "Use read tools to inspect Zendesk before making changes. Treat create, update, and comment tools as external writes. Internal notes default to non-public. Never expose OAuth credentials or raw token files in tool output.",
    },
  );

  server.registerTool(
    "zendesk_status",
    {
      title: "Check Zendesk connection",
      description: "Check OAuth configuration and return the authenticated user.",
      inputSchema: z.object({}),
      annotations: readAnnotations,
    },
    async () =>
      runTool(async () => {
        const response = await client.request<{ user: JsonObject }>(
          "/users/me.json",
        );
        return {
          configured: true,
          baseUrl: client.baseUrl,
          oauth: client.auth.status(),
          user: response.user,
        };
      }),
  );

  server.registerTool(
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
      runTool(async () => {
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

  server.registerTool(
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
      runTool(async () => {
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

  server.registerTool(
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
      runTool(async () => {
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

  server.registerTool(
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
      runTool(async () => {
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

  server.registerTool(
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
      runTool(async () => {
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
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

async function runTool(action: () => Promise<unknown>) {
  try {
    return toolResult(await action());
  } catch (error) {
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
