import { z } from "zod";
import type { JsonObject } from "./shared.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "./shared.js";
import { readAnnotations, type RegisterAllowedTool, type ToolContext } from "./register.js";

export function registerTicketMetadataTools(
  register: RegisterAllowedTool,
  ctx: ToolContext,
): void {
  const { client } = ctx;

  register(
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
    "read",
    async () => {
      const response = await client.request<{
        ticket_fields: JsonObject[];
      }>("/ticket_fields.json", { collection: "ticket_fields" });
      const count = response.ticket_fields.length;
      return {
        count,
        page: 1,
        perPage: count,
        nextPageAvailable: false,
        ticket_fields: response.ticket_fields,
      };
    },
  );

  register(
    "zendesk_get_ticket_field",
    {
      title: "Get Zendesk ticket field",
      description:
        "Get one Zendesk ticket field by id. Returns the ticket field object " +
        "as Zendesk returns it. Pass a ticket field's id from " +
        "zendesk_list_ticket_fields.",
      inputSchema: z.object({
        ticketFieldId: z
          .number()
          .int()
          .safe()
          .positive()
          .describe("Id of the ticket field to read."),
      }),
      annotations: readAnnotations,
    },
    "read",
    async ({ ticketFieldId }) => {
      // The schema guarantees ticketFieldId is a positive safe integer, so
      // it is safe to interpolate into the path.
      const response = await client.request<{ ticket_field: JsonObject }>(
        `/ticket_fields/${ticketFieldId}.json`,
        { object: "ticket_field" },
      );
      return { ticket_field: response.ticket_field };
    },
  );

  register(
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
    "read",
    async ({ page, perPage }) => {
      const response = await client.request<{
        ticket_forms: JsonObject[];
        count?: number;
        next_page?: string | null;
      }>("/ticket_forms.json", {
        query: { page, per_page: perPage },
        collection: "ticket_forms",
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
    },
  );

  register(
    "zendesk_get_ticket_form",
    {
      title: "Get Zendesk ticket form",
      description:
        "Get one Zendesk ticket form by id. Returns the ticket form object " +
        "as Zendesk returns it. Pass a ticket form's id from " +
        "zendesk_list_ticket_forms.",
      inputSchema: z.object({
        ticketFormId: z
          .number()
          .int()
          .safe()
          .positive()
          .describe("Id of the ticket form to read."),
      }),
      annotations: readAnnotations,
    },
    "read",
    async ({ ticketFormId }) => {
      // The schema guarantees ticketFormId is a positive safe integer, so
      // it is safe to interpolate into the path.
      const response = await client.request<{ ticket_form: JsonObject }>(
        `/ticket_forms/${ticketFormId}.json`,
        { object: "ticket_form" },
      );
      return { ticket_form: response.ticket_form };
    },
  );
}
