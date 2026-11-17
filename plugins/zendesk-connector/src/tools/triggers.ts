import { z } from "zod";
import type { JsonObject } from "./shared.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "./shared.js";
import { readAnnotations, type RegisterAllowedTool, type ToolContext } from "./register.js";

export function registerTriggerTools(
  register: RegisterAllowedTool,
  ctx: ToolContext,
): void {
  const { client } = ctx;

  register(
    "zendesk_list_triggers",
    {
      title: "List Zendesk triggers",
      description:
        "List Zendesk triggers — the business rules that fire on ticket " +
        "events — with page-based pagination. count is Zendesk's total " +
        "when provided, otherwise this page's length; triggers holds this " +
        "page, and nextPageAvailable says whether more pages exist — call " +
        "again with page to continue. Reading triggers can require an " +
        "account role and an OAuth scope the default scope does not " +
        "include, so a denied read means the token lacks the trigger " +
        "scope, not that no triggers exist. Pass a trigger's id to " +
        "zendesk_get_trigger.",
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
        triggers: JsonObject[];
        count?: number;
        next_page?: string | null;
      }>("/triggers.json", {
        query: { page, per_page: perPage },
        collection: "triggers",
      });
      const count =
        typeof response.count === "number"
          ? response.count
          : response.triggers.length;
      return {
        count,
        page,
        perPage,
        nextPageAvailable: Boolean(response.next_page),
        triggers: response.triggers,
      };
    },
  );

  register(
    "zendesk_get_trigger",
    {
      title: "Get Zendesk trigger",
      description:
        "Get one Zendesk trigger by id. Returns the trigger object as " +
        "Zendesk returns it, including its conditions and actions. " +
        "Conditions and actions are account-owned payloads passed through " +
        "unchanged. Pass a trigger's id from zendesk_list_triggers.",
      inputSchema: z.object({
        triggerId: z
          .number()
          .int()
          .safe()
          .positive()
          .describe("Id of the trigger to read."),
      }),
      annotations: readAnnotations,
    },
    "read",
    async ({ triggerId }) => {
      // The schema guarantees triggerId is a positive safe integer, so it is
      // safe to interpolate into the path.
      const response = await client.request<{ trigger: JsonObject }>(
        `/triggers/${triggerId}.json`,
        { object: "trigger" },
      );
      return { trigger: response.trigger };
    },
  );
}
