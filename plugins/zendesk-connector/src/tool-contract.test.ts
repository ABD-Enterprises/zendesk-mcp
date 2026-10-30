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

test("treats an empty next-page URL as the end of the thread", async () => {
  // The contract says the next-page URL is null when the thread ends here,
  // so an empty string reads as the end of the thread too.
  const { client } = contractClient((url) => {
    if (url.pathname.endsWith("/comments.json")) {
      return {
        comments: [EXAMPLE_COMMENT],
        users: [EXAMPLE_COMMENT_USER],
        next_page: "",
      };
    }
    return { ticket: EXAMPLE_TICKET, users: [], organizations: [] };
  });
  const session = await connectContracts(client);

  try {
    const payload = await contractPayload(session.client, "zendesk_get_ticket", {
      ticketId: 42,
    });

    assert.equal(payload.commentsNextPage, null);
    assert.equal(payload.commentsNextPageNumber, null);
    assert.equal(payload.commentsTruncated, false);
  } finally {
    await session.close();
  }
});

test("reads the first comment page when none is named", async () => {
  // The default is part of the promise the contract makes about the inputs,
  // so it is pinned: a default that moved would start the thread in the
  // middle.
  const { client, requests } = contractClient((url) => {
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

    const commentsRequest = requests.find((request) =>
      request.url.pathname.endsWith("/comments.json"),
    );
    assert.ok(commentsRequest);
    assert.equal(commentsRequest.url.searchParams.get("page"), "1");
    assert.equal(payload.commentPage, 1);
  } finally {
    await session.close();
  }
});

test("does not read the comments when they are not asked for", async () => {
  const { client, requests } = contractClient(() => ({
    ticket: EXAMPLE_TICKET,
    users: [],
    organizations: [],
  }));
  const session = await connectContracts(client);

  try {
    const payload = await contractPayload(session.client, "zendesk_get_ticket", {
      ticketId: 42,
      includeComments: false,
    });

    // A caller that says no comments gets no comments request.
    assert.equal(
      requests.some((request) => request.url.pathname.endsWith("/comments.json")),
      false,
    );
    // The contract says the comment fields are absent, so every one of them
    // is checked: a field that leaked into the payload would be a lie.
    for (const field of [
      "comments",
      "commentUsers",
      "commentPage",
      "commentsTruncated",
      "commentsNextPage",
      "commentsNextPageNumber",
    ]) {
      assert.equal(
        field in payload,
        false,
        `${field} should be absent when the comments are not asked for`,
      );
    }
  } finally {
    await session.close();
  }
});

test("reports the page number the account itself names", async () => {
  // The number is read out of the URL Zendesk sent, so the continuation is
  // the page the account points at rather than a number re-derived from the
  // page this call asked for.
  const { client } = contractClient((url) => {
    if (url.pathname.endsWith("/comments.json")) {
      return {
        comments: [EXAMPLE_COMMENT],
        users: [EXAMPLE_COMMENT_USER],
        next_page:
          "https://example.zendesk.com/api/v2/tickets/42/comments.json?page=5",
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

    assert.equal(payload.commentsNextPageNumber, 5);
  } finally {
    await session.close();
  }
});

test("falls back to the next page when the URL names no usable page", async () => {
  // A page of zero, or of half a page, or of a word, is not a page a caller
  // could read, so the number the tool reports is the page after the one it
  // asked for rather than the one the URL names.
  for (const page of ["0", "-1", "1.5", "abc", ""]) {
    const { client } = contractClient((url) => {
      if (url.pathname.endsWith("/comments.json")) {
        return {
          comments: [EXAMPLE_COMMENT],
          users: [EXAMPLE_COMMENT_USER],
          next_page: `https://example.zendesk.com/api/v2/tickets/42/comments.json?page=${page}`,
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

      assert.equal(payload.commentsNextPageNumber, 3, `page=${page}`);
    } finally {
      await session.close();
    }
  }
});

test("falls back to the next page when the URL names none", async () => {
  const { client } = contractClient((url) => {
    if (url.pathname.endsWith("/comments.json")) {
      return {
        comments: [EXAMPLE_COMMENT],
        users: [EXAMPLE_COMMENT_USER],
        next_page: "https://example.zendesk.com/api/v2/tickets/42/comments.json",
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

    assert.equal(payload.commentsNextPageNumber, 3);
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

test("refuses a tag that names nothing", async () => {
  const { client, requests } = contractClient(() => ({ ticket: EXAMPLE_TICKET }));
  const session = await connectContracts(client);

  try {
    // An empty string is a tag with no name. Both write tools refuse it.
    const updated = await callContract(session.client, "zendesk_update_ticket", {
      ticketId: 42,
      tags: [""],
    });
    assert.equal(updated.isError, true);

    const created = await callContract(session.client, "zendesk_create_ticket", {
      subject: "Example subject",
      comment: "Example body",
      tags: [""],
    });
    assert.equal(created.isError, true);

    // Neither call reached the account.
    assert.equal(requests.length, 0);
  } finally {
    await session.close();
  }
});

test("a new ticket starts with no tags when the list is empty", async () => {
  const { client, requests } = contractClient(() => ({ ticket: EXAMPLE_TICKET }));
  const session = await connectContracts(client);

  try {
    await contractPayload(session.client, "zendesk_create_ticket", {
      subject: "Example subject",
      comment: "Example body",
      tags: [],
    });

    // An empty list would tell Zendesk to remove every tag, and a new ticket
    // has none to remove, so the list is dropped rather than sent.
    assert.equal(requests.length, 1);
    const body = requests[0].body as { ticket: { tags?: string[] } };
    assert.equal(body.ticket.tags, undefined);
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

test("marks the write tools that overwrite or send as destructive, and pins the hints of both kinds", async () => {
  const { client } = contractClient(() => ({ ticket: EXAMPLE_TICKET }));
  // Every tool the connector offers, so a hint added to one of them is
  // caught rather than passed unnoticed.
  const session = await connectContracts(
    client,
    [
      "zendesk_status",
      "zendesk_search_tickets",
      "zendesk_get_ticket",
      "zendesk_create_ticket",
      "zendesk_update_ticket",
      "zendesk_add_ticket_comment",
      "zendesk_list_brands",
      "zendesk_list_groups",
      "zendesk_list_users",
      "zendesk_list_organizations",
      "zendesk_list_ticket_fields",
      "zendesk_list_ticket_forms",
    ].join(","),
  );

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

    // The whole object is pinned, so a hint that changes is a change a test
    // sees and not only one that is destructively true.
    assert.deepEqual(annotation("zendesk_update_ticket"), {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
    assert.deepEqual(annotation("zendesk_add_ticket_comment"), {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    assert.deepEqual(annotation("zendesk_create_ticket"), {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });

    // The read tools carry the other set of hints, and the whole object is
    // pinned there too: a read tool that claimed to be destructive, or that
    // claimed not to be idempotent, would change what a host does with it.
    // Every read tool is named, so a hint added to one of them would fail
    // here rather than pass unnoticed.
    for (const name of [
      "zendesk_status",
      "zendesk_search_tickets",
      "zendesk_get_ticket",
      "zendesk_list_brands",
      "zendesk_list_groups",
      "zendesk_list_users",
      "zendesk_list_organizations",
      "zendesk_list_ticket_fields",
      "zendesk_list_ticket_forms",
    ]) {
      assert.deepEqual(
        annotation(name),
        {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        `${name} should carry the read hints`,
      );
    }
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
async function connectContracts(
  zendesk: ZendeskClient,
  allowedTools?: string,
) {
  const server = createContractServer(zendesk, allowedTools);
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
function createContractServer(
  zendesk: ZendeskClient,
  allowedTools?: string,
) {
  const original = process.env.ZENDESK_ALLOWED_TOOLS;
  const originalReadOnly = process.env.ZENDESK_READ_ONLY;
  process.env.ZENDESK_ALLOWED_TOOLS =
    allowedTools ??
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
