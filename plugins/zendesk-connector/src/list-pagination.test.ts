import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ZendeskClient } from "./client.js";
import { createZendeskServer } from "./server.js";

const EXAMPLE_BRAND = { id: 501, name: "Example Brand", subdomain: "example" };
const SECOND_EXAMPLE_BRAND = {
  id: 502,
  name: "Second Example Brand",
  subdomain: "second",
};
const EXAMPLE_ORGANIZATION = { id: 601, name: "Example Organization" };
const EXAMPLE_GROUP = { id: 701, name: "Example Group" };
const EXAMPLE_USER = { id: 801, name: "Example User" };
const EXAMPLE_TICKET_FIELD = { id: 901, title: "Example Field", type: "text" };
const EXAMPLE_FORM = { id: 951, name: "Example Form" };
const EXAMPLE_NEXT_PAGE =
  "https://example.zendesk.com/api/v2/brands.json?page=2&per_page=25";
const GROUPS_NEXT_PAGE =
  "https://example.zendesk.com/api/v2/groups.json?page=3&per_page=10";
const TICKET_FIELDS_NEXT_PAGE =
  "https://example.zendesk.com/api/v2/ticket_fields.json?page=2&per_page=25";

/** Every list envelope carries these keys, in this order, before the resource. */
const ENVELOPE_KEYS = ["count", "page", "perPage", "nextPageAvailable"];

/** The caller-visible shape of a `zendesk_list_*` result. */
interface ListPayload {
  count: number;
  page: number;
  perPage: number;
  nextPageAvailable: boolean;
  [resource: string]: unknown;
}

/** What an MCP caller sees for one tool call. */
interface ToolCall {
  isError?: boolean;
  text: string;
}

test("lists the first brands page and reports that another page exists", async () => {
  // The tool forwards `page`/`per_page` to Zendesk and reduces the `next_page`
  // URL that comes back to the `nextPageAvailable` flag.
  const { client, requests } = listClient(() => ({
    brands: [EXAMPLE_BRAND, SECOND_EXAMPLE_BRAND],
    count: 42,
    page: 1,
    per_page: 25,
    next_page: EXAMPLE_NEXT_PAGE,
  }));
  const session = await connectLists(client);

  try {
    const payload = await listPayload(session.client, "zendesk_list_brands", {});

    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.pathname, "/api/v2/brands.json");
    assert.equal(request.searchParams.get("page"), "1");
    assert.equal(request.searchParams.get("per_page"), "25");

    assert.deepEqual(Object.keys(payload), [...ENVELOPE_KEYS, "brands"]);
    assert.equal(payload.count, 42);
    assert.equal(payload.page, 1);
    assert.equal(payload.perPage, 25);
    assert.equal(payload.nextPageAvailable, true);
    // Resource fields pass through untouched and keep their order: there is no
    // field mapping and no `agent_url`, because brands are not tickets.
    assert.deepEqual(payload.brands, [EXAMPLE_BRAND, SECOND_EXAMPLE_BRAND]);
    // The raw `next_page` URL stays on the Zendesk side: the caller advances by
    // passing the next `page`, so the tool only reports that one exists.
    assert.equal(JSON.stringify(payload).includes(EXAMPLE_NEXT_PAGE), false);
  } finally {
    await session.close();
  }
});

test("lists organizations with the requested page and reports the last page", async () => {
  const { client, requests } = listClient(() => ({
    organizations: [EXAMPLE_ORGANIZATION],
    count: 1,
    page: 3,
    per_page: 10,
  }));
  const session = await connectLists(client);

  try {
    const payload = await listPayload(session.client, "zendesk_list_organizations", {
      page: 3,
      perPage: 10,
    });

    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.pathname, "/api/v2/organizations.json");
    assert.equal(request.searchParams.get("page"), "3");
    assert.equal(request.searchParams.get("per_page"), "10");

    assert.deepEqual(Object.keys(payload), [...ENVELOPE_KEYS, "organizations"]);
    assert.equal(payload.count, 1);
    assert.equal(payload.page, 3);
    assert.equal(payload.perPage, 10);
    // An absent `next_page` on the last page reports no further page.
    assert.equal(payload.nextPageAvailable, false);
    assert.deepEqual(payload.organizations, [EXAMPLE_ORGANIZATION]);
  } finally {
    await session.close();
  }
});

test("lists groups with the requested page and reports that another page exists", async () => {
  const { client, requests } = listClient(() => ({
    groups: [EXAMPLE_GROUP],
    count: 30,
    page: 2,
    per_page: 10,
    next_page: GROUPS_NEXT_PAGE,
  }));
  const session = await connectLists(client);

  try {
    const payload = await listPayload(session.client, "zendesk_list_groups", {
      page: 2,
      perPage: 10,
    });

    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.pathname, "/api/v2/groups.json");
    // The caller's `page`/`perPage` reach Zendesk as `page`/`per_page`.
    assert.equal(request.searchParams.get("page"), "2");
    assert.equal(request.searchParams.get("per_page"), "10");

    assert.deepEqual(Object.keys(payload), [...ENVELOPE_KEYS, "groups"]);
    assert.equal(payload.count, 30);
    assert.equal(payload.page, 2);
    assert.equal(payload.perPage, 10);
    // A non-null `next_page` on the mock answer reports a further page.
    assert.equal(payload.nextPageAvailable, true);
    assert.deepEqual(payload.groups, [EXAMPLE_GROUP]);
    assert.equal(JSON.stringify(payload).includes(GROUPS_NEXT_PAGE), false);
  } finally {
    await session.close();
  }
});

test("lists users with the requested page and reports the last page", async () => {
  const { client, requests } = listClient(() => ({
    users: [EXAMPLE_USER],
    count: 3,
    page: 2,
    per_page: 10,
  }));
  const session = await connectLists(client);

  try {
    const payload = await listPayload(session.client, "zendesk_list_users", {
      page: 2,
      perPage: 10,
    });

    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.pathname, "/api/v2/users.json");
    assert.equal(request.searchParams.get("page"), "2");
    assert.equal(request.searchParams.get("per_page"), "10");

    assert.deepEqual(Object.keys(payload), [...ENVELOPE_KEYS, "users"]);
    assert.equal(payload.count, 3);
    assert.equal(payload.page, 2);
    assert.equal(payload.perPage, 10);
    // An absent `next_page` reports no further page, as for organizations.
    assert.equal(payload.nextPageAvailable, false);
    assert.deepEqual(payload.users, [EXAMPLE_USER]);
  } finally {
    await session.close();
  }
});

test("lists ticket fields with the requested page and reports that another page exists", async () => {
  const { client, requests } = listClient(() => ({
    ticket_fields: [EXAMPLE_TICKET_FIELD],
    count: 30,
    page: 1,
    per_page: 25,
    next_page: TICKET_FIELDS_NEXT_PAGE,
  }));
  const session = await connectLists(client);

  try {
    const payload = await listPayload(session.client, "zendesk_list_ticket_fields", {});

    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.pathname, "/api/v2/ticket_fields.json");
    assert.equal(request.searchParams.get("page"), "1");
    assert.equal(request.searchParams.get("per_page"), "25");

    // The envelope's resource key is camelCase, like `nextPageAvailable`.
    assert.deepEqual(Object.keys(payload), [...ENVELOPE_KEYS, "ticketFields"]);
    assert.equal(payload.count, 30);
    assert.equal(payload.page, 1);
    assert.equal(payload.perPage, 25);
    assert.equal(payload.nextPageAvailable, true);
    assert.deepEqual(payload.ticketFields, [EXAMPLE_TICKET_FIELD]);
    assert.equal(JSON.stringify(payload).includes(TICKET_FIELDS_NEXT_PAGE), false);
  } finally {
    await session.close();
  }
});

test("lists forms with the requested page and reports the last page", async () => {
  const { client, requests } = listClient(() => ({
    forms: [EXAMPLE_FORM],
    count: 3,
    page: 2,
    per_page: 10,
  }));
  const session = await connectLists(client);

  try {
    const payload = await listPayload(session.client, "zendesk_list_forms", {
      page: 2,
      perPage: 10,
    });

    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.pathname, "/api/v2/forms.json");
    assert.equal(request.searchParams.get("page"), "2");
    assert.equal(request.searchParams.get("per_page"), "10");

    assert.deepEqual(Object.keys(payload), [...ENVELOPE_KEYS, "forms"]);
    assert.equal(payload.count, 3);
    assert.equal(payload.page, 2);
    assert.equal(payload.perPage, 10);
    // An absent `next_page` reports no further page, as for organizations.
    assert.equal(payload.nextPageAvailable, false);
    assert.deepEqual(payload.forms, [EXAMPLE_FORM]);
  } finally {
    await session.close();
  }
});

test("falls back to the item count when Zendesk omits count", async () => {
  const { client, requests } = listClient(() => ({
    brands: [EXAMPLE_BRAND],
    next_page: null,
  }));
  const session = await connectLists(client);

  try {
    const payload = await listPayload(session.client, "zendesk_list_brands", {});

    assert.equal(requests.length, 1);
    assert.deepEqual(Object.keys(payload), [...ENVELOPE_KEYS, "brands"]);
    assert.equal(payload.count, 1);
    assert.equal(payload.page, 1);
    assert.equal(payload.perPage, 25);
    assert.equal(payload.nextPageAvailable, false);
    assert.deepEqual(payload.brands, [EXAMPLE_BRAND]);
  } finally {
    await session.close();
  }
});

test("rejects a page size above the supported maximum before calling Zendesk", async () => {
  const { client, requests } = listClient(() => ({ brands: [] }));
  const session = await connectLists(client);

  try {
    const result = await callList(session.client, "zendesk_list_brands", {
      perPage: 101,
    });

    assert.equal(result.isError, true);
    assert.equal(requests.length, 0);
  } finally {
    await session.close();
  }
});

/** A Zendesk client whose resource endpoint answers with `respond`. */
function listClient(respond: (params: URLSearchParams) => Record<string, unknown>): {
  client: ZendeskClient;
  requests: URL[];
} {
  const requests: URL[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    return Response.json(respond(url.searchParams));
  };
  const client = new ZendeskClient(
    {
      baseUrl: "https://example.zendesk.com",
      mode: "access_token",
      accessToken: "oauth-access-token",
      tokenFile: "/unused/oauth.json",
      scope: "tickets:read",
    },
    fetcher,
  );
  return { client, requests };
}

/** Connects an MCP client to a server exposing the tested list tools. */
async function connectLists(zendesk: ZendeskClient) {
  const server = createListServer(zendesk);
  const client = new Client({ name: "list-pagination-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

async function callList(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCall> {
  const result = await client.callTool({ name, arguments: args });
  const blocks = result.content as Array<{ type: string; text?: string }>;
  const first = blocks[0];
  assert.ok(first, "the tool result should carry a content block");
  assert.equal(first.type, "text");
  const isError = result.isError;
  return {
    isError: typeof isError === "boolean" ? isError : undefined,
    text: first.text ?? "",
  };
}

async function listPayload(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ListPayload> {
  const result = await callList(client, name, args);
  // A successful tool result carries no error flag at all.
  assert.notEqual(result.isError, true, result.text);
  return JSON.parse(result.text) as ListPayload;
}

/** Creates a server that exposes the tested list tools whatever the policy is. */
function createListServer(zendesk: ZendeskClient) {
  const original = process.env.ZENDESK_ALLOWED_TOOLS;
  process.env.ZENDESK_ALLOWED_TOOLS =
    "zendesk_list_brands,zendesk_list_organizations,zendesk_list_groups,zendesk_list_users,zendesk_list_ticket_fields,zendesk_list_forms";
  try {
    return createZendeskServer(zendesk);
  } finally {
    if (original === undefined) delete process.env.ZENDESK_ALLOWED_TOOLS;
    else process.env.ZENDESK_ALLOWED_TOOLS = original;
  }
}
