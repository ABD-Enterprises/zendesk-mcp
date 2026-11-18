import { z } from "zod";
import type { JsonObject } from "./shared.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "./shared.js";
import { readAnnotations, type RegisterAllowedTool, type ToolContext } from "./register.js";

export function registerMacroTools(
  register: RegisterAllowedTool,
  ctx: ToolContext,
): void {
  const { client } = ctx;

  register(
    "zendesk_list_macros",
    {
      title: "List Zendesk macros",
      description:
        "List the macros in a Zendesk account — the prepared answers and " +
        "actions an agent can apply to a ticket — with page-based " +
        "pagination. count is Zendesk's total when provided, otherwise this " +
        "page's length; macros holds this page, and nextPageAvailable says " +
        "whether more pages exist — call again with page to continue. Pass a " +
        "macro's id to zendesk_get_macro for the actions it applies.",
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
        macros: JsonObject[];
        count?: number;
        next_page?: string | null;
      }>("/macros.json", {
        query: { page, per_page: perPage },
        collection: "macros",
      });
      const count =
        typeof response.count === "number" ? response.count : response.macros.length;
      return {
        count,
        page,
        perPage,
        nextPageAvailable: Boolean(response.next_page),
        macros: response.macros,
      };
    },
  );

  register(
    "zendesk_get_macro",
    {
      title: "Get Zendesk macro",
      description:
        "Get one Zendesk macro by id. Returns the macro object as Zendesk " +
        "returns it, with the actions it applies. Pass a macro's id from " +
        "zendesk_list_macros.",
      inputSchema: z.object({
        macroId: z
          .number()
          .int()
          .safe()
          .positive()
          .describe("Id of the macro to read."),
      }),
      annotations: readAnnotations,
    },
    "read",
    async ({ macroId }) => {
      // The schema guarantees macroId is a positive safe integer, so it is
      // safe to interpolate into the path.
      const response = await client.request<{ macro: JsonObject }>(
        `/macros/${macroId}.json`,
        { object: "macro" },
      );
      return { macro: response.macro };
    },
  );
}
