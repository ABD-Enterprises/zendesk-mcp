import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ZendeskClient } from "./client.js";
import { createZendeskServer } from "./server.js";

const SEARCH_QUERY = "type:ticket status<solved";
const EXAMPLE_TICKET = {
  id: 1001,
  subject: "Example ticket",
  status: "solved",
};
const SECOND_EXAMPLE_TICKET = {
  id: 1002,
  subject: "Another example ticket",
  status: "open",
};
const EXAMPLE_AGENT_URL = "https://example.zendesk.com/agent/tickets/1001";
const SECOND_EXAMPLE_AGENT_URL = "https://example.zendesk.com/agent/tickets/1002";
const EXAMPLE_NEXT_PAGE =
  "https://example.zendesk.com/api/v2/search.json?page=2&per_page=25&query=type%3Aticket%20status%3Csolved";

/** The caller-visible shape of a `zendesk_search_tickets` result. */
interface SearchPayload {
  count?: number;
  page: number;
  perPage: number;
  nextPageAvailable: boolean;
  results: Array<Record<string, unknown>>;
}

/** What an MCP caller sees for one tool call. */
interface ToolCall {
  isError?: boolean;
  text: string;
}

test("surfaces the first search page and reports that another page exists", async () => {
  // The tool forwards `page`/`per_page` to Zendesk and reduces the `next_page`
  // URL that comes back to the `nextPageAvailable` flag.
  const { client, requests } = searchClient(() => ({
    count: 42,
    results: [EXAMPLE_TICKET, SECOND_EXAMPLE_TICKET],
    next_page: EXAMPLE_NEXT_PAGE,
  }));
  const session = await connectSearch(client);

  try {
    const payload = await searchPayload(session.client, { query: SEARCH_QUERY });

    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.pathname, "/api/v2/search.json");
    assert.equal(request.searchParams.get("query"), SEARCH_QUERY);
    assert.equal(request.searchParams.get("page"), "1");
    assert.equal(request.searchParams.get("per_page"), "25");

    assert.equal(payload.nextPageAvailable, true);
    assert.equal(payload.page, 1);
    assert.equal(payload.perPage, 25);
    assert.equal(payload.count, 42);
    // Ticket fields are passed through untouched and keep their order; only
    // `resultType` and `agent_url` are added.
    assert.deepEqual(payload.results, [
      { ...EXAMPLE_TICKET, resultType: "ticket", agent_url: EXAMPLE_AGENT_URL },
      { ...SECOND_EXAMPLE_TICKET, resultType: "ticket", agent_url: SECOND_EXAMPLE_AGENT_URL },
    ]);
    // The raw `next_page` URL stays on the Zendesk side: the caller advances by
    // passing the next `page`, so the tool only reports that one exists.
    assert.equal(JSON.stringify(payload).includes(EXAMPLE_NEXT_PAGE), false);
  } finally {
    await session.close();
  }
});

test("reports no further page when the last search page has no next_page", async () => {
  const lastPageResponses: Array<Record<string, unknown>> = [
    { count: 2, results: [EXAMPLE_TICKET] },
    { count: 2, results: [EXAMPLE_TICKET], next_page: null },
  ];

  for (const response of lastPageResponses) {
    const { client, requests } = searchClient(() => response);
    const session = await connectSearch(client);

    try {
      const payload = await searchPayload(session.client, { query: SEARCH_QUERY });

      assert.equal(requests.length, 1);
      assert.equal(payload.nextPageAvailable, false);
      assert.equal(payload.page, 1);
      assert.equal(payload.perPage, 25);
      assert.equal(payload.count, 2);
      assert.deepEqual(payload.results, [
        { ...EXAMPLE_TICKET, resultType: "ticket", agent_url: EXAMPLE_AGENT_URL },
      ]);
    } finally {
      await session.close();
    }
  }
});

test("carries the requested page into a follow-up search request", async () => {
  const { client, requests } = searchClient((params) =>
    params.get("page") === "1"
      ? {
          count: 30,
          results: [EXAMPLE_TICKET],
          next_page: EXAMPLE_NEXT_PAGE,
        }
      : { count: 30, results: [{ id: 1002, subject: "Another example ticket" }] },
  );
  const session = await connectSearch(client);

  try {
    const first = await searchPayload(session.client, {
      query: SEARCH_QUERY,
      perPage: 10,
    });
    assert.equal(first.nextPageAvailable, true);
    assert.equal(first.page, 1);
    assert.equal(first.perPage, 10);

    const second = await searchPayload(session.client, {
      query: SEARCH_QUERY,
      perPage: 10,
      page: 2,
    });
    assert.equal(second.nextPageAvailable, false);
    assert.equal(second.page, 2);
    assert.equal(second.perPage, 10);

    assert.equal(requests.length, 2);
    assert.equal(requests[0].searchParams.get("page"), "1");
    assert.equal(requests[1].searchParams.get("page"), "2");
    assert.equal(requests[1].searchParams.get("per_page"), "10");
    assert.equal(requests[1].searchParams.get("query"), SEARCH_QUERY);
  } finally {
    await session.close();
  }
});

test("handles an absent or malformed next_page without failing the search", async () => {
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ["an absent next_page", { count: 1, results: [EXAMPLE_TICKET] }, false],
    ["a null next_page", { count: 1, results: [EXAMPLE_TICKET], next_page: null }, false],
    ["an empty next_page", { count: 1, results: [EXAMPLE_TICKET], next_page: "" }, false],
    [
      // A truthy but unusable value still counts as another page: the tool
      // never parses the URL, it only checks that one was returned.
      "a next_page that is not a URL",
      { count: 1, results: [EXAMPLE_TICKET], next_page: "not-a-url" },
      true,
    ],
    [
      "a next_page of the wrong type",
      { count: 1, results: [EXAMPLE_TICKET], next_page: { url: EXAMPLE_NEXT_PAGE } },
      true,
    ],
  ];

  for (const [label, response, expected] of cases) {
    const { client, requests } = searchClient(() => response);
    const session = await connectSearch(client);

    try {
      const payload = await searchPayload(session.client, { query: SEARCH_QUERY });

      assert.equal(requests.length, 1, label);
      assert.equal(
        payload.nextPageAvailable,
        expected,
        `${label} should report nextPageAvailable=${expected}`,
      );
      assert.equal(payload.page, 1, label);
      assert.equal(payload.perPage, 25, label);
      assert.equal(payload.count, 1, label);
      assert.deepEqual(
        payload.results,
        [{ ...EXAMPLE_TICKET, resultType: "ticket", agent_url: EXAMPLE_AGENT_URL }],
        label,
      );
    } finally {
      await session.close();
    }
  }
});

test("forwards the requested page size to Zendesk", async () => {
  const { client, requests } = searchClient(() => ({ count: 0, results: [] }));
  const session = await connectSearch(client);

  try {
    const payload = await searchPayload(session.client, {
      query: SEARCH_QUERY,
      perPage: 5,
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].searchParams.get("per_page"), "5");
    assert.equal(requests[0].searchParams.get("page"), "1");
    assert.equal(payload.perPage, 5);
    assert.equal(payload.page, 1);
    assert.deepEqual(payload.results, []);
  } finally {
    await session.close();
  }
});

test("falls back to the default page size when the caller omits one", async () => {
  const { client, requests } = searchClient(() => ({ count: 0, results: [] }));
  const session = await connectSearch(client);

  try {
    const payload = await searchPayload(session.client, { query: SEARCH_QUERY });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].searchParams.get("per_page"), "25");
    assert.equal(requests[0].searchParams.get("page"), "1");
    assert.equal(payload.perPage, 25);
    assert.equal(payload.page, 1);
  } finally {
    await session.close();
  }
});

test("omits the count when Zendesk does not return one", async () => {
  const { client } = searchClient(() => ({ results: [EXAMPLE_TICKET] }));
  const session = await connectSearch(client);

  try {
    const payload = await searchPayload(session.client, { query: SEARCH_QUERY });

    assert.equal(payload.count, undefined);
    assert.equal(Object.keys(payload).includes("count"), false);
    assert.equal(payload.nextPageAvailable, false);
  } finally {
    await session.close();
  }
});

test("rejects a page size above the supported maximum before calling Zendesk", async () => {
  const { client, requests } = searchClient(() => ({ count: 0, results: [] }));
  const session = await connectSearch(client);

  try {
    const result = await callSearch(session.client, {
      query: SEARCH_QUERY,
      perPage: 101,
    });

    assert.equal(result.isError, true);
    assert.equal(requests.length, 0);
  } finally {
    await session.close();
  }
});

/** A Zendesk client whose search endpoint answers with `respond`. */
function searchClient(respond: (params: URLSearchParams) => Record<string, unknown>): {
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

/** Connects an MCP client to a search-only server over the mock client. */
async function connectSearch(zendesk: ZendeskClient) {
  const server = createSearchServer(zendesk);
  const client = new Client({ name: "pagination-test", version: "1.0.0" });
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

async function callSearch(
  client: Client,
  args: Record<string, unknown>,
): Promise<ToolCall> {
  const result = await client.callTool({
    name: "zendesk_search_tickets",
    arguments: args,
  });
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

async function searchPayload(
  client: Client,
  args: Record<string, unknown>,
): Promise<SearchPayload> {
  const result = await callSearch(client, args);
  // A successful tool result carries no error flag at all.
  assert.notEqual(result.isError, true, result.text);
  return JSON.parse(result.text) as SearchPayload;
}

/** Creates a server that exposes the search tool whatever the ambient policy is. */
function createSearchServer(zendesk: ZendeskClient) {
  const original = process.env.ZENDESK_ALLOWED_TOOLS;
  process.env.ZENDESK_ALLOWED_TOOLS = "zendesk_search_tickets";
  try {
    return createZendeskServer(zendesk);
  } finally {
    if (original === undefined) delete process.env.ZENDESK_ALLOWED_TOOLS;
    else process.env.ZENDESK_ALLOWED_TOOLS = original;
  }
}
