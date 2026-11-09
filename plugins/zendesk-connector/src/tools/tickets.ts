import { z } from "zod";
import { ZendeskError, type ZendeskClient } from "../client.js";
import type { JsonObject } from "./shared.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "./shared.js";
import {
  readAnnotations,
  writeAnnotations,
  type RegisterAllowedTool,
  type ToolContext,
} from "./register.js";

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

export function registerTicketTools(
  register: RegisterAllowedTool,
  ctx: ToolContext,
): void {
  const { client } = ctx;

  register(
    "zendesk_search_tickets",
    {
      title: "Search Zendesk tickets",
      description:
        "Search Zendesk with Zendesk search syntax. Example: type:ticket " +
        "status<solved priority:high. The result is one page: count is the " +
        "number of matches Zendesk reports — a search total can be " +
        "approximate or absent — results holds this page, and " +
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
    "read",
    async ({ query, page, perPage }) => {
      const response = await client.request<{
        results: JsonObject[];
        count?: number;
        next_page?: string | null;
      }>("/search.json", {
        query: { query, page, per_page: perPage },
        collection: "results",
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
    },
  );

  register(
    "zendesk_get_ticket",
    {
      title: "Get Zendesk ticket",
      description:
        "Get a Zendesk ticket with requester, assignee, organization, and " +
        "the page of its comments named by commentPage. Zendesk returns a " +
        "ticket's comments oldest first, so the first page holds the start " +
        "of the thread — unless a trigger adds a comment when the ticket is " +
        "created, which Zendesk does not order. commentsTruncated says " +
        "whether more comment pages exist; call again with " +
        "commentsNextPageNumber to read on.",
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
    "read",
    async ({ ticketId: id, includeComments, commentPage }) => {
      const ticketResponse = await client.request<{
        ticket: JsonObject;
        users?: JsonObject[];
        organizations?: JsonObject[];
      }>(`/tickets/${id}.json`, {
        query: { include: "users,organizations" },
        object: "ticket",
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
        collection: "comments",
      });

      return {
        ...ticketResponse,
        comments: commentsResponse.comments,
        commentUsers: commentsResponse.users,
        commentPage,
        commentsTruncated: Boolean(commentsResponse.next_page),
        commentsNextPage: commentsResponse.next_page || null,
        // The page number to read on with. Zendesk's own next_page URL is
        // reported too, but it is a URL and the tool takes a number, so the
        // number is what a caller can actually use. It is the number
        // Zendesk put in that URL, so the continuation is the page the
        // account itself points at; the arithmetic is the fallback for an
        // account that sends no page in the URL.
        commentsNextPageNumber: commentsResponse.next_page
          ? nextPageNumber(commentsResponse.next_page, commentPage + 1)
          : null,
        agent_url: ticketUrl(client, id),
      };
    },
  );

  register(
    "zendesk_create_ticket",
    {
      title: "Create Zendesk ticket",
      description:
        "Create a Zendesk ticket. The ticket is customer-visible: it appears " +
        "in the requester's account and, when email notifications are on, it " +
        "reaches them by email. The fields given are set, and the first " +
        "comment's visibility is sent with it. This tool cannot set a " +
        "custom field, a due date or a macro. Returns the created ticket, " +
        "including its id and agent_url.",
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
    "write",
    async (input) => {
      const response = await client.request<{ ticket: JsonObject }>(
        "/tickets.json",
        { method: "POST", body: buildTicketPayload(input), object: "ticket" },
      );
      const id = ticketId(response.ticket);
      return {
        ...response,
        agent_url: id ? ticketUrl(client, id) : undefined,
      };
    },
  );

  register(
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
    "write",
    async ({ ticketId: id, ...updates }) => {
      if (Object.values(updates).every((value) => value === undefined)) {
        throw new ZendeskError("No update fields were provided.");
      }
      const response = await client.request<{ ticket: JsonObject }>(
        `/tickets/${id}.json`,
        { method: "PUT", body: buildTicketPayload(updates), object: "ticket" },
      );
      return { ...response, agent_url: ticketUrl(client, id) };
    },
  );

  register(
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
    "write",
    async ({ ticketId: id, body, public: isPublic }) => {
      const response = await client.request<{ ticket: JsonObject }>(
        `/tickets/${id}.json`,
        {
          method: "PUT",
          body: { ticket: { comment: { body, public: isPublic } } },
          object: "ticket",
        },
      );
      return { ...response, agent_url: ticketUrl(client, id) };
    },
  );
}

function ticketUrl(client: ZendeskClient, id: number | string): string {
  return `${client.baseUrl}/agent/tickets/${id}`;
}

/**
 * The page number a Zendesk `next_page` URL points at.
 *
 * The number is read out of the URL the account sent, so the continuation is
 * the page the account itself names. The arithmetic fallback covers an
 * account that sends a URL with no page in it.
 */
function nextPageNumber(nextPage: string, fallback: number): number {
  try {
    const page = new URL(nextPage, "https://zendesk.invalid").searchParams.get("page");
    const parsed = Number(page);
    if (page !== null && Number.isInteger(parsed) && parsed > 0) return parsed;
  } catch {
    // A URL the parser refuses carries no page, so the fallback stands.
  }
  return fallback;
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
 * organizations, and says which is which in the result's result_type. The
 * name is lower-cased, so a result that says "Ticket" is still a ticket.
 * A result that names no type, or names one that is not a string, is
 * treated as a ticket, which is what the endpoint returned before the type
 * was read.
 */
function searchResultType(result: JsonObject): string {
  const type = result.result_type;
  if (typeof type !== "string" || type === "") return "ticket";
  return type.toLowerCase();
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
  // An empty array would tell Zendesk to remove every tag on the ticket, so
  // the update schema refuses one; the builder keeps the guarantee on its
  // own too. A new ticket has no tags to remove, so the create tool drops
  // an empty list rather than sending it.
  if (input.tags && input.tags.length > 0) ticket.tags = input.tags;
  if (input.comment) {
    // The visibility is sent explicitly. The contract says the requester
    // sees this comment, and a field the connector leaves out is a field
    // whose behaviour it does not control. The schema's default is the
    // source of truth, so anything but an explicit false is public.
    ticket.comment = { body: input.comment, public: input.public !== false };
  }
  if (input.requesterEmail) {
    ticket.requester = {
      email: input.requesterEmail,
      name: input.requesterName ?? input.requesterEmail,
    };
  }
  return { ticket };
}
