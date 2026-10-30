import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ZendeskClient } from "./client.js";
import { createZendeskServer } from "./server.js";

const EXAMPLE_TICKET = { id: 42, subject: "Example ticket" };
const EXAMPLE_COMMENT = { id: 7, body: "Example comment", author_id: 801 };
const EXAMPLE_COMMENT_USER = { id: 801, name: "Example Comment Author" };
// The URL Zendesk points at when a thread has more comments. It is the page
// after the one the call asked for.
const EXAMPLE_COMMENT_NEXT_PAGE =
  "https://example.zendesk.com/api/v2/tickets/42/comments.json?page=3";

/** One request the connector sent to Zendesk. */
interface RecordedRequest {
  url: URL;
  method: string;
  body: unknown;
}

/** What an MCP caller sees for one tool call. */
interface ToolCall {
  isError?: boolean;
  text: string;
}

test("asks Zendesk for the comment authors when it reads a ticket's comments", async () => {
  const { client, requests } = contractClient((url) => {
    if (url.pathname.endsWith("/comments.json")) {
      return {
        comments: [EXAMPLE_COMMENT],
        users: [EXAMPLE_COMMENT_USER],
        next_page: null,
      };
    }
    return { ticket: EXAMPLE_TICKET, users: [], organizations: [] };
  });
  const session = await connectContracts(client);

  try {
    const payload = await contractPayload(session.client, "zendesk_get_ticket", {
      ticketId: 42,
    });

    // The side-load has to be asked for on the comments endpoint itself: the
    // ticket's own side-load does not reach it.
    const commentsRequest = requests.find((request) =>
      request.url.pathname.endsWith("/comments.json"),
    );
    assert.ok(commentsRequest, "the comments endpoint should be called");
    assert.equal(commentsRequest.url.searchParams.get("include"), "users");

    // The contract promises the comment authors, so they are there.
    assert.deepEqual(payload.commentUsers, [EXAMPLE_COMMENT_USER]);
    assert.deepEqual(payload.comments, [EXAMPLE_COMMENT]);
    assert.equal(payload.commentsTruncated, false);
    assert.equal(payload.commentsNextPage, null);
  } finally {
    await session.close();
  }
});

test("reads the comment page it is asked for and reports the next one", async () => {
  const { client, requests } = contractClient((url) => {
    if (url.pathname.endsWith("/comments.json")) {
      return {
        comments: [EXAMPLE_COMMENT],
        users: [EXAMPLE_COMMENT_USER],
        next_page: EXAMPLE_COMMENT_NEXT_PAGE,
      };
    }
    return { ticket: EXAMPLE_TICKET, users: [], organizations: [] };
  });
  const session = await connectContracts(client);

  try {
    const payload = await contractPayload(session.client, "zendesk_get_ticket", {
      ticketId: 42,
      commentPage: 2,
    });

    const commentsRequest = requests.find((request) =>
      request.url.pathname.endsWith("/comments.json"),
    );
    assert.ok(commentsRequest);
    assert.equal(commentsRequest.url.searchParams.get("page"), "2");
    assert.equal(payload.commentPage, 2);
    assert.equal(payload.commentsTruncated, true);
    assert.equal(payload.commentsNextPage, EXAMPLE_COMMENT_NEXT_PAGE);
    // The tool takes a page number, so the continuation it reports has to be
    // a number: the URL Zendesk returned cannot be passed back to it.
    assert.equal(payload.commentsNextPageNumber, 3);
  } finally {
    await session.close();
  }
});

test("reports no continuation when the thread ends here", async () => {
  const { client } = contractClient((url) => {
    if (url.pathname.endsWith("/comments.json")) {
      return { comments: [EXAMPLE_COMMENT], users: [EXAMPLE_COMMENT_USER] };
    }
    return { ticket: EXAMPLE_TICKET, users: [], organizations: [] };
  });
  const session = await connectContracts(client);

  try {
    const payload = await contractPayload(session.client, "zendesk_get_ticket", {
      ticketId: 42,
    });

    assert.equal(payload.commentsTruncated, false);
    assert.equal(payload.commentsNextPage, null);
    assert.equal(payload.commentsNextPageNumber, null);
  } finally {
    await session.close();
  }
});

test("labels every search result with the kind of record it is", async () => {
  const { client } = contractClient(() => ({
    count: 2,
    results: [
      { id: 42, subject: "Example ticket", result_type: "ticket" },
      { id: 801, name: "Example User", result_type: "user" },
    ],
  }));
  const session = await connectContracts(client);

  try {
    const payload = await contractPayload(session.client, "zendesk_search_tickets", {
      query: "type:ticket",
    });
    const results = payload.results as Array<Record<string, unknown>>;

    assert.equal(results[0].resultType, "ticket");
    assert.equal(
      results[0].agent_url,
      "https://example.zendesk.com/agent/tickets/42",
    );
    // A user result is not a ticket, so it gets no ticket URL.
    assert.equal(results[1].resultType, "user");
    assert.equal(results[1].agent_url, undefined);
  } finally {
    await session.close();
  }
});

test("treats a search result without a type as a ticket", async () => {
  const { client } = contractClient(() => ({
    count: 1,
    results: [{ id: 42, subject: "Example ticket" }],
  }));
  const session = await connectContracts(client);

  try {
    const payload = await contractPayload(session.client, "zendesk_search_tickets", {
      query: "type:ticket",
    });
    const results = payload.results as Array<Record<string, unknown>>;

    assert.equal(results[0].resultType, "ticket");
    assert.equal(
      results[0].agent_url,
      "https://example.zendesk.com/agent/tickets/42",
    );
  } finally {
    await session.close();
  }
});

test("reads the type of a search result the way it is spelled", async () => {
  const { client } = contractClient(() => ({
    count: 2,
    results: [
      { id: 42, subject: "Example ticket", result_type: "Ticket" },
      { id: 801, name: "Example User", result_type: "Organization" },
    ],
  }));
  const session = await connectContracts(client);

  try {
    const payload = await contractPayload(session.client, "zendesk_search_tickets", {
      query: "type:ticket",
    });
    const results = payload.results as Array<Record<string, unknown>>;

    // The name is lower-cased, so a result that says "Ticket" is still a
    // ticket and still gets its ticket URL.
    assert.equal(results[0].resultType, "ticket");
    assert.equal(
      results[0].agent_url,
      "https://example.zendesk.com/agent/tickets/42",
    );
    // A name the tool does not know is lower-cased too, and it gets no
    // ticket URL.
    assert.equal(results[1].resultType, "organization");
    assert.equal(results[1].agent_url, undefined);
  } finally {
    await session.close();
  }
});

test("refuses an empty tags array instead of clearing a ticket's tags", async () => {
  const { client, requests } = contractClient(() => ({ ticket: EXAMPLE_TICKET }));
  const session = await connectContracts(client);

  try {
    const result = await callContract(session.client, "zendesk_update_ticket", {
      ticketId: 42,
      tags: [],
    });

    // Zendesk reads an empty list as "remove every tag", so the call is
    // refused before it reaches the account.
    assert.equal(result.isError, true);
    assert.equal(requests.length, 0);
  } finally {
    await session.close();
  }
});

test("sends the tags it is given", async () => {
  const { client, requests } = contractClient(() => ({ ticket: EXAMPLE_TICKET }));
  const session = await connectContracts(client);

  try {
    await contractPayload(session.client, "zendesk_update_ticket", {
      ticketId: 42,
      tags: ["example-tag"],
    });

    assert.equal(requests.length, 1);
    const body = requests[0].body as { ticket: { tags: string[] } };
    assert.deepEqual(body.ticket.tags, ["example-tag"]);
  } finally {
    await session.close();
  }
});

test("sends the first comment's visibility instead of relying on a default", async () => {
  const { client, requests } = contractClient(() => ({ ticket: EXAMPLE_TICKET }));
  const session = await connectContracts(client);

  try {
    await contractPayload(session.client, "zendesk_create_ticket", {
      subject: "Example subject",
      comment: "Example body",
    });

    // The contract says the requester sees this comment, so the visibility
    // travels with the request instead of being left to a server default.
    assert.equal(requests.length, 1);
    const body = requests[0].body as {
      ticket: { comment: { body: string; public: boolean } };
    };
    assert.deepEqual(body.ticket.comment, { body: "Example body", public: true });

    await contractPayload(session.client, "zendesk_create_ticket", {
      subject: "Example subject",
      comment: "Example body",
      public: false,
    });
    const internal = requests[1].body as {
      ticket: { comment: { body: string; public: boolean } };
    };
    assert.deepEqual(internal.ticket.comment, {
      body: "Example body",
      public: false,
    });
  } finally {
    await session.close();
  }
});

test("the session instructions name both comment defaults", async () => {
  const { client } = contractClient(() => ({}));
  const session = await connectContracts(client);

  try {
    // The instructions are read by an agent at the start of a session, so
    // they have to agree with the tools: a comment added to an existing
    // ticket is internal by default, and the first comment of a new ticket
    // is public.
    const instructions = session.client.getInstructions() ?? "";
    assert.match(
      instructions,
      /first comment of a new ticket is public/i,
      `the instructions should name the create default: ${instructions}`,
    );
    assert.ok(
      !/internal notes default to non-public/i.test(instructions),
      `the instructions must not claim every comment is internal: ${instructions}`,
    );
  } finally {
    await session.close();
  }
});

test("marks the write tools that overwrite or send as destructive", async () => {
  const { client } = contractClient(() => ({ ticket: EXAMPLE_TICKET }));
  const session = await connectContracts(client);

  try {
    const tools = await session.client.listTools();
    const annotation = (name: string) =>
      tools.tools.find((tool) => tool.name === name)?.annotations;

    // An update overwrites fields that already exist, and a public reply
    // cannot be withdrawn.
    assert.equal(annotation("zendesk_update_ticket")?.destructiveHint, true);
    assert.equal(annotation("zendesk_add_ticket_comment")?.destructiveHint, true);
    // Creating a record adds one without changing another.
    assert.equal(annotation("zendesk_create_ticket")?.destructiveHint, false);
  } finally {
    await session.close();
  }
});

test("describes the result shape, the continuation and the ticket handoff", async () => {
  const { client } = contractClient(() => ({ results: [] }));
  const session = await connectContracts(client);

  try {
    const tools = await session.client.listTools();
    const description = (name: string) =>
      tools.tools.find((tool) => tool.name === name)?.description ?? "";

    // An agent reads these to learn how to use the tools.
    assert.match(description("zendesk_search_tickets"), /zendesk_get_ticket/);
    assert.match(description("zendesk_search_tickets"), /nextPageAvailable/);
    assert.match(description("zendesk_search_tickets"), /resultType/);
    assert.match(description("zendesk_update_ticket"), /tags/);
    assert.match(description("zendesk_add_ticket_comment"), /internal note/i);
  } finally {
    await session.close();
  }
});

/** A Zendesk client whose endpoints answer with `respond`. */
function contractClient(
  respond: (url: URL) => Record<string, unknown>,
): { client: ZendeskClient; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return Response.json(respond(url));
  };
  const client = new ZendeskClient(
    {
      baseUrl: "https://example.zendesk.com",
      mode: "access_token",
      accessToken: "oauth-access-token",
      tokenFile: "/unused/oauth.json",
      scope: "tickets:read tickets:write",
    },
    fetcher,
  );
  return { client, requests };
}

/** Connects an MCP client to a server exposing the tested tools. */
async function connectContracts(zendesk: ZendeskClient) {
  const server = createContractServer(zendesk);
  const client = new Client({ name: "tool-contract-test", version: "1.0.0" });
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

async function callContract(
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

async function contractPayload(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await callContract(client, name, args);
  assert.notEqual(result.isError, true, result.text);
  return JSON.parse(result.text) as Record<string, unknown>;
}

/** Creates a server that exposes the tested tools whatever the policy is. */
function createContractServer(zendesk: ZendeskClient) {
  const original = process.env.ZENDESK_ALLOWED_TOOLS;
  const originalReadOnly = process.env.ZENDESK_READ_ONLY;
  process.env.ZENDESK_ALLOWED_TOOLS =
    "zendesk_get_ticket,zendesk_search_tickets,zendesk_create_ticket,zendesk_update_ticket,zendesk_add_ticket_comment";
  delete process.env.ZENDESK_READ_ONLY;
  try {
    return createZendeskServer(zendesk);
  } finally {
    if (original === undefined) delete process.env.ZENDESK_ALLOWED_TOOLS;
    else process.env.ZENDESK_ALLOWED_TOOLS = original;
    if (originalReadOnly === undefined) delete process.env.ZENDESK_READ_ONLY;
    else process.env.ZENDESK_READ_ONLY = originalReadOnly;
  }
}
