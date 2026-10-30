import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ZendeskAuthError } from "./auth.js";
import { audit, redact } from "./audit.js";
import { ZendeskClient, ZendeskError } from "./client.js";
import { assertToolAllowed, configuredTools, type ZendeskToolName } from "./policy.js";
import { PACKAGE_VERSION } from "./version.js";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

type JsonObject = Record<string, unknown>;

export function createZendeskServer(client = new ZendeskClient()): McpServer {
  const allowedTools = configuredTools();
  let actorId: number | string | undefined;
  const server = new McpServer(
    { name: "zendesk-mcp", version: PACKAGE_VERSION },
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
        "Search Zendesk with Zendesk search syntax. Example: type:ticket " +
        "status<solved priority:high. The result is one page: count is the " +
        "total number of matches, results holds this page, and " +
        "nextPageAvailable says whether more pages exist — call again with " +
        "page to continue. Without a type: qualifier the search also returns " +
        "users, groups and organizations; every result carries its " +
        "resultType, and only a ticket result carries an agent_url. Pass a " +
        "ticket's id to zendesk_get_ticket for the full record.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe(
            "Zendesk search query. Include type:ticket unless searching " +
              "broadly.",
          ),
        page: z
          .number()
          .int()
          .positive()
          .default(1)
          .describe("Page of results to return, starting at 1."),
        perPage: z
          .number()
          .int()
          .positive()
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe("How many results one page holds, up to 100."),
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
          results: response.results.map((result) => {
            // The search endpoint is shared: without a type: qualifier it
            // answers with users, groups and organizations too, and each
            // result says what it is in result_type.
            const resultType = searchResultType(result);
            const id = ticketId(result);
            return {
              ...result,
              resultType,
              agent_url:
                resultType === "ticket" && id ? ticketUrl(client, id) : undefined,
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
        "Get a Zendesk ticket with requester, assignee, organization, and " +
        "the page of its comments named by commentPage. Zendesk returns a " +
        "ticket's comments oldest first, so the first page holds the start " +
        "of the thread. commentsTruncated says whether more comment pages " +
        "exist; call again with the next commentPage to read on.",
      inputSchema: z.object({
        ticketId: z
          .number()
          .int()
          .positive()
          .describe("Id of the ticket to read."),
        includeComments: z
          .boolean()
          .default(true)
          .describe("Whether to read the ticket's comments at all."),
        commentPage: z
          .number()
          .int()
          .positive()
          .default(1)
          .describe("Page of comments to return, starting at 1."),
      }),
      annotations: readAnnotations,
    },
    async ({ ticketId: id, includeComments, commentPage }) =>
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

        // The side-load is asked for on the comments endpoint itself: the
        // ticket's own side-load does not reach this one, so without it the
        // comment authors would never resolve.
        const commentsResponse = await client.request<{
          comments: JsonObject[];
          users?: JsonObject[];
          next_page?: string | null;
        }>(`/tickets/${id}/comments.json`, {
          query: { include: "users", page: commentPage },
        });

        return {
          ...ticketResponse,
          comments: commentsResponse.comments,
          commentUsers: commentsResponse.users,
          commentPage,
          commentsTruncated: Boolean(commentsResponse.next_page),
          commentsNextPage: commentsResponse.next_page ?? null,
          agent_url: ticketUrl(client, id),
        };
      }),
  );

  allowedTools.has("zendesk_create_ticket") && server.registerTool(
    "zendesk_create_ticket",
    {
      title: "Create Zendesk ticket",
      description:
        "Create a Zendesk ticket. The ticket is customer-visible: it appears " +
        "in the requester's account and, when email notifications are on, it " +
        "reaches them by email. Only the fields given are set. Returns the " +
        "created ticket, including its id and agent_url.",
      inputSchema: z.object({
        subject: z
          .string()
          .min(1)
          .describe("Short title of the ticket, shown in the queue."),
        comment: z
          .string()
          .min(1)
          .describe(
            "Body of the first comment on the ticket. It is public unless " +
              "public is false, so the requester sees it.",
          ),
        public: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            "Whether the first comment is public. True (the default) sends " +
              "it to the requester; false keeps it an internal note that the " +
              "requester cannot see.",
          ),
        requesterEmail: z
          .string()
          .email()
          .optional()
          .describe(
            "Email address of the requester. Without it the ticket is " +
              "created for the authenticated agent.",
          ),
        requesterName: z
          .string()
          .optional()
          .describe(
            "Name of the requester. Defaults to the requester email address.",
          ),
        priority: TicketPriority.optional().describe("Priority of the ticket."),
        status: TicketStatus.optional().describe("Status of the ticket."),
        type: TicketType.optional().describe("Type of the ticket."),
        tags: z
          .array(z.string().min(1))
          .optional()
          .describe("Tags to set on the new ticket."),
      }),
      annotations: writeAnnotations({ idempotent: false, destructive: false }),
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
        "Update a Zendesk ticket. Only the fields given change; every other " +
        "field is left as it is. The updatable fields are subject, priority, " +
        "status, type and tags — this tool cannot reassign a ticket, change " +
        "its requester or edit its comment. tags replaces every tag the " +
        "ticket has, so it needs at least one tag. Returns the updated " +
        "ticket.",
      inputSchema: z.object({
        ticketId: z
          .number()
          .int()
          .positive()
          .describe("Id of the ticket to update."),
        subject: z
          .string()
          .min(1)
          .optional()
          .describe("New title of the ticket."),
        priority: TicketPriority.optional().describe("New priority."),
        status: TicketStatus.optional().describe("New status."),
        type: TicketType.optional().describe("New type."),
        tags: z
          .array(z.string().min(1))
          .min(1, {
            error:
              "tags must name at least one tag. This tool replaces every tag " +
              "on the ticket, so it cannot remove them all.",
          })
          .optional()
          .describe(
            "The tags the ticket should carry. This replaces every tag the " +
              "ticket has, so at least one tag is required.",
          ),
      }),
      annotations: writeAnnotations({ idempotent: true, destructive: true }),
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
      description:
        "Add a comment to a Zendesk ticket. The comment is an internal note " +
        "by default. A public reply is irreversible: it reaches the customer " +
        "by email, and it cannot be unsent from here. Returns the updated " +
        "ticket. This tool cannot edit or delete a comment.",
      inputSchema: z.object({
        ticketId: z
          .number()
          .int()
          .positive()
          .describe("Id of the ticket to comment on."),
        body: z
          .string()
          .min(1)
          .describe("The comment's text. It is sent as given."),
        public: z
          .boolean()
          .default(false)
          .describe(
            "False creates an internal note. True sends a public reply to " +
              "the customer, which cannot be withdrawn.",
          ),
      }),
      annotations: writeAnnotations({ idempotent: false, destructive: true }),
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

  allowedTools.has("zendesk_list_brands") && server.registerTool(
    "zendesk_list_brands",
    {
      title: "List Zendesk brands",
      description: "List Zendesk brands with page-based pagination.",
      inputSchema: z.object({
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
    async ({ page, perPage }) =>
      runTool("zendesk_list_brands", "read", actorId, async () => {
        guard("zendesk_list_brands");
        const response = await client.request<{
          brands: JsonObject[];
          count?: number;
          next_page?: string | null;
        }>("/brands.json", {
          query: { page, per_page: perPage },
        });
        const count =
          typeof response.count === "number" ? response.count : response.brands.length;
        return {
          count,
          page,
          perPage,
          nextPageAvailable: Boolean(response.next_page),
          brands: response.brands,
        };
      }),
  );

  allowedTools.has("zendesk_list_groups") && server.registerTool(
    "zendesk_list_groups",
    {
      title: "List Zendesk groups",
      description: "List Zendesk groups with page-based pagination.",
      inputSchema: z.object({
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
    async ({ page, perPage }) =>
      runTool("zendesk_list_groups", "read", actorId, async () => {
        guard("zendesk_list_groups");
        const response = await client.request<{
          groups: JsonObject[];
          count?: number;
          next_page?: string | null;
        }>("/groups.json", {
          query: { page, per_page: perPage },
        });
        const count =
          typeof response.count === "number" ? response.count : response.groups.length;
        return {
          count,
          page,
          perPage,
          nextPageAvailable: Boolean(response.next_page),
          groups: response.groups,
        };
      }),
  );

  allowedTools.has("zendesk_list_users") && server.registerTool(
    "zendesk_list_users",
    {
      title: "List Zendesk users",
      description: "List Zendesk users with page-based pagination.",
      inputSchema: z.object({
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
    async ({ page, perPage }) =>
      runTool("zendesk_list_users", "read", actorId, async () => {
        guard("zendesk_list_users");
        const response = await client.request<{
          users: JsonObject[];
          count?: number;
          next_page?: string | null;
        }>("/users.json", {
          query: { page, per_page: perPage },
        });
        const count =
          typeof response.count === "number" ? response.count : response.users.length;
        return {
          count,
          page,
          perPage,
          nextPageAvailable: Boolean(response.next_page),
          users: response.users,
        };
      }),
  );

  allowedTools.has("zendesk_list_organizations") && server.registerTool(
    "zendesk_list_organizations",
    {
      title: "List Zendesk organizations",
      description: "List Zendesk organizations with page-based pagination.",
      inputSchema: z.object({
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
    async ({ page, perPage }) =>
      runTool("zendesk_list_organizations", "read", actorId, async () => {
        guard("zendesk_list_organizations");
        const response = await client.request<{
          organizations: JsonObject[];
          count?: number;
          next_page?: string | null;
        }>("/organizations.json", {
          query: { page, per_page: perPage },
        });
        const count =
          typeof response.count === "number" ? response.count : response.organizations.length;
        return {
          count,
          page,
          perPage,
          nextPageAvailable: Boolean(response.next_page),
          organizations: response.organizations,
        };
      }),
  );

  allowedTools.has("zendesk_list_ticket_fields") && server.registerTool(
    "zendesk_list_ticket_fields",
    {
      title: "List Zendesk ticket fields",
      description:
        "List all Zendesk ticket fields. The endpoint returns the complete " +
        "list in one response and documents no offset pagination, so the " +
        "call takes no parameters.",
      inputSchema: z.object({}),
      annotations: readAnnotations,
    },
    async () =>
      runTool("zendesk_list_ticket_fields", "read", actorId, async () => {
        guard("zendesk_list_ticket_fields");
        const response = await client.request<{
          ticket_fields: JsonObject[];
        }>("/ticket_fields.json");
        const count = response.ticket_fields.length;
        return {
          count,
          page: 1,
          perPage: count,
          nextPageAvailable: false,
          ticket_fields: response.ticket_fields,
        };
      }),
  );

  allowedTools.has("zendesk_list_ticket_forms") && server.registerTool(
    "zendesk_list_ticket_forms",
    {
      title: "List Zendesk ticket forms",
      description: "List Zendesk ticket forms with page-based pagination.",
      inputSchema: z.object({
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
    async ({ page, perPage }) =>
      runTool("zendesk_list_ticket_forms", "read", actorId, async () => {
        guard("zendesk_list_ticket_forms");
        const response = await client.request<{
          ticket_forms: JsonObject[];
          count?: number;
          next_page?: string | null;
        }>("/ticket_forms.json", {
          query: { page, per_page: perPage },
        });
        const count =
          typeof response.count === "number" ? response.count : response.ticket_forms.length;
        return {
          count,
          page,
          perPage,
          nextPageAvailable: Boolean(response.next_page),
          ticket_forms: response.ticket_forms,
        };
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

/**
 * The annotations of a write tool.
 *
 * `destructive` says whether the tool may overwrite something that already
 * exists. It is not a read-only flag: a tool that only adds records is
 * additive, while one that replaces a ticket's fields or sends a public reply
 * destroys something — and a host that trusts the hint would otherwise skip
 * the confirmation prompt for exactly those two.
 */
function writeAnnotations(options: {
  idempotent: boolean;
  destructive: boolean;
}) {
  return {
    readOnlyHint: false,
    destructiveHint: options.destructive,
    idempotentHint: options.idempotent,
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

/**
 * The kind of record a search result carries.
 *
 * Zendesk's search endpoint answers with tickets, users, groups and
 * organizations, and says which is which in the result's result_type. A
 * result that names no type is treated as a ticket, which is what the
 * endpoint returned before the type was read.
 */
function searchResultType(result: JsonObject): string {
  const type = result.result_type;
  return typeof type === "string" && type !== "" ? type : "ticket";
}

function buildTicketPayload(input: {
  subject?: string;
  comment?: string;
  public?: boolean;
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
  // An empty array would tell Zendesk to remove every tag on the ticket. The
  // schema rejects it; the builder keeps the guarantee on its own too.
  if (input.tags && input.tags.length > 0) ticket.tags = input.tags;
  if (input.comment) {
    // The visibility is sent explicitly. The contract says the requester
    // sees this comment, and a field the connector leaves out is a field
    // whose behaviour it does not control.
    ticket.comment = { body: input.comment, public: input.public ?? true };
  }
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
