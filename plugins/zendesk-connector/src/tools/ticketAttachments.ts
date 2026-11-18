import { z } from "zod";
import type { JsonObject } from "./shared.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "./shared.js";
import { readAnnotations, type RegisterAllowedTool, type ToolContext } from "./register.js";

export function registerTicketAttachmentTools(
  register: RegisterAllowedTool,
  ctx: ToolContext,
): void {
  const { client } = ctx;

  register(
    "zendesk_list_ticket_attachments",
    {
      title: "List Zendesk ticket attachments",
      description:
        "List the files attached to one Zendesk ticket — what the customer " +
        "sent — with page-based pagination. count is Zendesk's total when " +
        "provided, otherwise this page's length; attachments holds this " +
        "page, and nextPageAvailable says whether more pages exist — call " +
        "again with page to continue. The records name the file and how to " +
        "read it; the connector does not download the content.",
      inputSchema: z.object({
        ticketId: z
          .number()
          .int()
          .safe()
          .positive()
          .describe("Id of the ticket to read the attachments of."),
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
        attachments: JsonObject[];
        count?: number;
        next_page?: string | null;
      }>(`/tickets/${ticketId}/attachments.json`, {
        query: { page, per_page: perPage },
        collection: "attachments",
      });
      const count =
        typeof response.count === "number"
          ? response.count
          : response.attachments.length;
      return {
        count,
        page,
        perPage,
        nextPageAvailable: Boolean(response.next_page),
        attachments: response.attachments,
      };
    },
  );
}
