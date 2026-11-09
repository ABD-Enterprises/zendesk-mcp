import { z } from "zod";
import type { JsonObject } from "./shared.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "./shared.js";
import { readAnnotations, type RegisterAllowedTool, type ToolContext } from "./register.js";

export function registerDirectoryTools(
  register: RegisterAllowedTool,
  ctx: ToolContext,
): void {
  const { client } = ctx;

  register(
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
    "read",
    async ({ page, perPage }) => {
      const response = await client.request<{
        brands: JsonObject[];
        count?: number;
        next_page?: string | null;
      }>("/brands.json", {
        query: { page, per_page: perPage },
        collection: "brands",
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
    },
  );

  register(
    "zendesk_get_brand",
    {
      title: "Get Zendesk brand",
      description:
        "Get one Zendesk brand by id. Returns the brand object as Zendesk " +
        "returns it. Pass a brand's id from zendesk_list_brands.",
      inputSchema: z.object({
        brandId: z
          .number()
          .int()
          .safe()
          .positive()
          .describe("Id of the brand to read."),
      }),
      annotations: readAnnotations,
    },
    "read",
    async ({ brandId }) => {
      // The schema guarantees brandId is a positive safe integer, so it is
      // safe to interpolate into the path.
      const response = await client.request<{ brand: JsonObject }>(
        `/brands/${brandId}.json`,
        { object: "brand" },
      );
      return { brand: response.brand };
    },
  );

  register(
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
    "read",
    async ({ page, perPage }) => {
      const response = await client.request<{
        groups: JsonObject[];
        count?: number;
        next_page?: string | null;
      }>("/groups.json", {
        query: { page, per_page: perPage },
        collection: "groups",
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
    },
  );

  register(
    "zendesk_get_group",
    {
      title: "Get Zendesk group",
      description:
        "Get one Zendesk group by id. Returns the group object as Zendesk " +
        "returns it. Pass a group's id from zendesk_list_groups.",
      inputSchema: z.object({
        groupId: z
          .number()
          .int()
          .safe()
          .positive()
          .describe("Id of the group to read."),
      }),
      annotations: readAnnotations,
    },
    "read",
    async ({ groupId }) => {
      // The schema guarantees groupId is a positive safe integer, so it is
      // safe to interpolate into the path.
      const response = await client.request<{ group: JsonObject }>(
        `/groups/${groupId}.json`,
        { object: "group" },
      );
      return { group: response.group };
    },
  );

  register(
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
    "read",
    async ({ page, perPage }) => {
      const response = await client.request<{
        users: JsonObject[];
        count?: number;
        next_page?: string | null;
      }>("/users.json", {
        query: { page, per_page: perPage },
        collection: "users",
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
    },
  );

  register(
    "zendesk_get_user",
    {
      title: "Get Zendesk user",
      description:
        "Get one Zendesk user by id. Returns the user object as Zendesk " +
        "returns it. Pass a user's id from zendesk_list_users or from a " +
        "user result of zendesk_search_tickets.",
      inputSchema: z.object({
        userId: z
          .number()
          .int()
          .positive()
          .describe("Id of the user to read."),
      }),
      annotations: readAnnotations,
    },
    "read",
    async ({ userId }) => {
      // The schema guarantees userId is a positive integer, so it is
      // safe to interpolate into the path.
      const response = await client.request<{ user: JsonObject }>(
        `/users/${userId}.json`,
        { object: "user" },
      );
      return { user: response.user };
    },
  );

  register(
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
    "read",
    async ({ page, perPage }) => {
      const response = await client.request<{
        organizations: JsonObject[];
        count?: number;
        next_page?: string | null;
      }>("/organizations.json", {
        query: { page, per_page: perPage },
        collection: "organizations",
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
    },
  );

  register(
    "zendesk_get_organization",
    {
      title: "Get Zendesk organization",
      description:
        "Get one Zendesk organization by id. Returns the organization " +
        "object as Zendesk returns it. Pass an organization's id from " +
        "zendesk_list_organizations, from the organization side-loaded on " +
        "a ticket by zendesk_get_ticket, or from an organization result " +
        "of zendesk_search_tickets.",
      inputSchema: z.object({
        organizationId: z
          .number()
          .int()
          .positive()
          .describe("Id of the organization to read."),
      }),
      annotations: readAnnotations,
    },
    "read",
    async ({ organizationId }) => {
      // The schema guarantees organizationId is a positive integer, so
      // it is safe to interpolate into the path.
      const response = await client.request<{ organization: JsonObject }>(
        `/organizations/${organizationId}.json`,
        { object: "organization" },
      );
      return { organization: response.organization };
    },
  );
}
