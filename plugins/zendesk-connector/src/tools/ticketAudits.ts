import { z } from "zod";
import type { JsonObject } from "./shared.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "./shared.js";
import { readAnnotations, type RegisterAllowedTool, type ToolContext } from "./register.js";

export function registerTicketAuditTools(
  register: RegisterAllowedTool,
  ctx: ToolContext,
): void {
  const { client } = ctx;

  register(
    "zendesk_list_ticket_audits",
    {
      title: "List Zendesk ticket audits",
      description:
        "List the audits of one Zendesk ticket — its history: every change " +
        "made to it, who made it and when, and which automation fired — " +
        "with page-based pagination. count is Zendesk's total when " +
        "provided, otherwise this page's length; audits holds this page, " +
        "and nextPageAvailable says whether more pages exist — call again " +
        "with page to continue. Each audit carries the events it records " +
        "under its own events key; the audits carry the ticket's history, " +
        "not its current fields, so read zendesk_get_ticket for those.",
      inputSchema: z.object({
        ticketId: z
          .number()
          .int()
          .safe()
          .positive()
          .describe("Id of the ticket to read the audits of."),
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
    "read",
    async ({ ticketId, page, perPage }) => {
      // The schema guarantees ticketId is a positive safe integer, so it is
      // safe to interpolate into the path.
      const response = await client.request<{
        audits: JsonObject[];
        count?: number;
        next_page?: string | null;
      }>(`/tickets/${ticketId}/audits.json`, {
        query: { page, per_page: perPage },
        collection: "audits",
      });
      const count =
        typeof response.count === "number" ? response.count : response.audits.length;
      return {
        count,
        page,
        perPage,
        nextPageAvailable: Boolean(response.next_page),
        audits: response.audits,
      };
    },
  );
}
