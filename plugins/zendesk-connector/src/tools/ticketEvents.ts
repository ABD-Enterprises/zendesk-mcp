import { z } from "zod";
import type { JsonObject } from "./shared.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "./shared.js";
import { readAnnotations, type RegisterAllowedTool, type ToolContext } from "./register.js";

export function registerTicketEventTools(
  register: RegisterAllowedTool,
  ctx: ToolContext,
): void {
  const { client } = ctx;

  register(
    "zendesk_list_ticket_events",
    {
      title: "List Zendesk ticket events",
      description:
        "List the events on one Zendesk ticket — the audit trail: every " +
        "change to the ticket, who made it and when, and which automation " +
        "fired — with page-based pagination. count is Zendesk's total when " +
        "provided, otherwise this page's length; events holds this page, and " +
        "nextPageAvailable says whether more pages exist — call again with " +
        "page to continue. The events carry the ticket's history, not its " +
        "current fields: read zendesk_get_ticket for those.",
      inputSchema: z.object({
        ticketId: z
          .number()
          .int()
          .safe()
          .positive()
          .describe("Id of the ticket to read the events of."),
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
        events: JsonObject[];
        count?: number;
        next_page?: string | null;
      }>(`/tickets/${ticketId}/events.json`, {
        query: { page, per_page: perPage },
        collection: "events",
      });
      const count =
        typeof response.count === "number" ? response.count : response.events.length;
      return {
        count,
        page,
        perPage,
        nextPageAvailable: Boolean(response.next_page),
        events: response.events,
      };
    },
  );
}
