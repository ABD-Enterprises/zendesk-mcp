import { z } from "zod";
import type { JsonObject } from "./shared.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "./shared.js";
import { readAnnotations, type RegisterAllowedTool, type ToolContext } from "./register.js";

export function registerViewTools(
  register: RegisterAllowedTool,
  ctx: ToolContext,
): void {
  const { client } = ctx;

  register(
    "zendesk_list_views",
    {
      title: "List Zendesk views",
      description:
        "List Zendesk ticket views — the shared and personal views the " +
        "authenticated user can see — with page-based pagination. count " +
        "is Zendesk's total when provided, otherwise this page's length; " +
        "views holds this page, and nextPageAvailable says whether more " +
        "pages exist — call again with page to continue. Pass a view's id to " +
        "zendesk_list_view_tickets for the tickets in it.",
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
    "read",
    async ({ page, perPage }) => {
      const response = await client.request<{
        views: JsonObject[];
        count?: number;
        next_page?: string | null;
      }>("/views.json", {
        query: { page, per_page: perPage },
        collection: "views",
      });
      const count =
        typeof response.count === "number" ? response.count : response.views.length;
      return {
        count,
        page,
        perPage,
        nextPageAvailable: Boolean(response.next_page),
        views: response.views,
      };
    },
  );

  register(
    "zendesk_list_view_tickets",
    {
      title: "List tickets in a Zendesk view",
      description:
        "List the tickets in one Zendesk view, with page-based pagination. " +
        "The endpoint documents no total, so count falls back to this " +
        "page's length; nextPageAvailable says whether more pages exist — " +
        "call again with page to continue. Pass a ticket's id to " +
        "zendesk_get_ticket for the full record.",
      inputSchema: z.object({
        viewId: z
          .number()
          .int()
          .safe()
          .positive()
          .describe("Id of the view to read tickets from."),
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
    async ({ viewId, page, perPage }) => {
      // The schema guarantees viewId is a positive integer, so it is
      // safe to interpolate into the path.
      const response = await client.request<{
        tickets: JsonObject[];
        count?: number;
        next_page?: string | null;
      }>(`/views/${viewId}/tickets.json`, {
        query: { page, per_page: perPage },
        collection: "tickets",
      });
      // The documented response sample carries no count, so the page
      // length is the fallback, as for ticket forms.
      const count =
        typeof response.count === "number"
          ? response.count
          : response.tickets.length;
      return {
        count,
        page,
        perPage,
        nextPageAvailable: Boolean(response.next_page),
        tickets: response.tickets,
      };
    },
  );

  register(
    "zendesk_get_view",
    {
      title: "Get Zendesk view",
      description:
        "Get one Zendesk ticket view by id. Returns the view object as " +
        "Zendesk returns it. Pass a view's id from zendesk_list_views.",
      inputSchema: z.object({
        viewId: z
          .number()
          .int()
          .safe()
          .positive()
          .describe("Id of the view to read."),
      }),
      annotations: readAnnotations,
    },
    "read",
    async ({ viewId }) => {
      // The schema guarantees viewId is a positive safe integer, so it is
      // safe to interpolate into the path.
      const response = await client.request<{ view: JsonObject }>(
        `/views/${viewId}.json`,
        { object: "view" },
      );
      return { view: response.view };
    },
  );
}
