# Tool contracts

This document is the reference for the connector's MCP tool surface: what each
tool accepts, what it returns, how failures and audit events are shaped, how a
deployment narrows the surface with the allowlist, and what the version number
promises about future changes to any of it. It describes the server as
implemented. Where a payload is passed through from Zendesk, its fields belong
to the account and the API version and are not part of this contract.

Every tool result is a JSON payload in a single `text` content block, so a
caller parses the block's text to get the value described below. A call the
MCP SDK refuses before a handler runs — a schema-validation failure, or a
tool the allowlist filtered out — is refused rather than wrapped in this
envelope.

## Tools

| Tool | Access | Purpose | Inputs (types and defaults) | Audit |
| --- | --- | --- | --- | --- |
| `zendesk_status` | Read | Verify OAuth and identify the authenticated user | None | Yes |
| `zendesk_search_tickets` | Read | Search tickets with Zendesk search syntax | `query` string (required); `page` int (default 1); `perPage` int (default 25, max 100) | Yes |
| `zendesk_get_ticket` | Read | Read a ticket with users, organization, and comments | `ticketId` int (required); `includeComments` bool (default true) | Yes |
| `zendesk_list_brands` | Read | List brands with page-based pagination | `page` int (default 1); `perPage` int (default 25, max 100) | Yes |
| `zendesk_list_groups` | Read | List groups with page-based pagination | `page` int (default 1); `perPage` int (default 25, max 100) | Yes |
| `zendesk_list_users` | Read | List users with page-based pagination | `page` int (default 1); `perPage` int (default 25, max 100) | Yes |
| `zendesk_list_organizations` | Read | List organizations with page-based pagination | `page` int (default 1); `perPage` int (default 25, max 100) | Yes |
| `zendesk_list_ticket_fields` | Read | List all ticket fields (one unpaginated response) | None | Yes |
| `zendesk_list_ticket_forms` | Read | List ticket forms with page-based pagination | `page` int (default 1); `perPage` int (default 25, max 100) | Yes |
| `zendesk_create_ticket` | Write | Create a ticket | `subject` string (required); `comment` string (required); `requesterEmail` valid email (optional); `requesterName` string (optional); `priority` enum: urgent, high, normal, low (optional); `status` enum: new, open, pending, hold, solved, closed (optional); `type` enum: problem, incident, question, task (optional); `tags` array of strings (optional) | Yes |
| `zendesk_update_ticket` | Write | Update common ticket fields | `ticketId` int (required); `subject` string (optional); `priority`, `status`, `type` enums as in create (optional); `tags` array of strings (optional); at least one update field required | Yes |
| `zendesk_add_ticket_comment` | Write | Add an internal note or public reply | `ticketId` int (required); `body` string (required); `public` bool (default false) | Yes |

Notes on the inputs:

- `requesterName` is used only when `requesterEmail` is provided; the requester
  then defaults to the email address.
- `zendesk_add_ticket_comment` defaults `public` to false, so an omitted value
  creates an internal note.
- `zendesk_update_ticket` rejects a call whose update fields are all absent
  with the error `No update fields were provided.`
- `page` starts at 1 and `perPage` is capped at 100 for every paginated tool.
- Input is validated against the tool's schema before the call runs. A call
  that fails validation is refused by the MCP SDK and never reaches Zendesk or
  the audit log.

## Result envelope

A successful call returns its payload as one `text` content block containing
pretty-printed JSON. There is no wrapper object; the payload is exactly what
the sections below describe.

### List and search results

The six list tools and `zendesk_search_tickets` return a shared envelope:

```json
{
  "count": 128,
  "page": 1,
  "perPage": 25,
  "nextPageAvailable": true
}
```

- `page` and `perPage` echo the values the call used.
  `zendesk_list_ticket_fields` takes no parameters, so its envelope always
  reports a single page: `page` 1, `perPage` equal to `count`, and
  `nextPageAvailable` false.
- `nextPageAvailable` is true when Zendesk reports another page; the caller
  advances by calling again with `page` incremented.
- `count` is the total Zendesk reports. The list tools fall back to the
  returned page's length when the API omits it; the search tool omits the field
  entirely when Zendesk reports no total, because a search total can be
  approximate or absent.
- The items follow under a tool-specific key: `brands`, `groups`, `users`,
  `organizations`, `ticket_fields`, `ticket_forms`, or `results` for search.

Each search result additionally gains an `agent_url` field (see below) when
the result carries a ticket id.

### zendesk_status

Returns `configured` (always true on success), `baseUrl`, `oauth`, and `user`:

- `baseUrl` is the resolved Zendesk base URL.
- `oauth` summarizes the session: `mode` (`authorization_code`,
  `client_credentials`, or `access_token`), `scope`, `refreshEnabled`, and
  `expiresAt` while an access token is held in memory. In
  `authorization_code` mode it also names the token file's path — never the
  file's contents.
- `user` is the authenticated user object as Zendesk returns it from the
  current-user endpoint.

A successful `zendesk_status` call is also what establishes `actorId` for
subsequent audit events (see Audit).

### zendesk_get_ticket

Returns the Zendesk ticket payload — `{ "ticket", "users", "organizations" }`,
with `users` and `organizations` present when Zendesk side-loads them — plus
`agent_url`. When `includeComments` is true (the default), the payload also
carries:

- `comments`: the first page of the ticket's comments.
- `commentUsers`: the users referenced by that page of comments.
- `commentsTruncated`: true when more comment pages exist beyond the ones
  returned.

With `includeComments` false, the comment fields are absent.

### Write results

`zendesk_create_ticket`, `zendesk_update_ticket`, and
`zendesk_add_ticket_comment` return the Zendesk payload of the ticket they
created or modified — `{ "ticket", ... }` — plus `agent_url`. For
`zendesk_create_ticket`, `agent_url` is present when the response carries the
new ticket's id.

### agent_url

Tools that return a single ticket add `agent_url`, the agent-interface URL for
that ticket: `<baseUrl>/agent/tickets/<id>`. Search results carry the same
field per item when the item has an id. It is a convenience link, not an API
endpoint; the tools never call it.

## Error contract

A failed call returns a tool result with `isError: true` and a single `text`
content block containing JSON. The payload always has an `error` key with the
message. Failures that come from the Zendesk client or the auth layer also
carry `status` and `details` when they have them:

```json
{
  "error": "Zendesk API request failed: HTTP 404 Not Found",
  "status": 404,
  "details": {
    "response": { "error": { "title": "RecordNotFound", "description": "Not found" } },
    "retryAfterSeconds": 1
  }
}
```

Errors that map from the client layer:

- A Zendesk HTTP failure surfaces as `Zendesk API request failed: HTTP
  <status> <statusText>`, with `status` set to the HTTP code and `details`
  carrying Zendesk's own error body under `response` plus the rate-limit
  headers when present: `retryAfterSeconds`, `rateLimitRemaining`, and
  `rateLimitResetSeconds`.
- Before failing, the client retries a `401` once with a refreshed token when
  the mode allows refresh, and retries `429` up to `ZENDESK_MAX_RETRIES`
  times (default 2), waiting no longer than `ZENDESK_MAX_RETRY_DELAY_MS`
  (default 10000) per attempt. A longer advertised wait is returned as an
  error instead of being slept out.
- A failure obtaining or refreshing an access token surfaces as an auth error
  with the same `error` / `status` / `details` shape.
- The `zendesk_update_ticket` no-fields rejection is a client-side error with
  a message and no status.

Startup problems — missing OAuth configuration, an unreadable client file, an
invalid `ZENDESK_ALLOWED_TOOLS` value, or an invalid `ZENDESK_READ_ONLY`
value — prevent the server from starting rather than returning a tool error.

What the error payload never contains: OAuth credentials, access or refresh
tokens, or token-file contents. The payload is passed through a redaction step
that replaces any value whose key contains `token`, `secret`, `password`,
`authorization`, or `cookie` (case-insensitive) with `[REDACTED]`, recursively.
The `details.response` body is whatever Zendesk's own error response said; it
does not echo the connector's credentials.

## Annotations contract

Every read tool — `zendesk_status`, `zendesk_search_tickets`,
`zendesk_get_ticket`, and the six `zendesk_list_*` tools — is marked:

```json
{ "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": true }
```

Every write tool is marked `readOnlyHint: false`, `destructiveHint: false`,
`openWorldHint: true`, with the idempotency hint set per tool:

- `zendesk_update_ticket`: `idempotentHint: true` — repeating an update with
  the same field values leaves the ticket in the same state.
- `zendesk_create_ticket` and `zendesk_add_ticket_comment`:
  `idempotentHint: false` — each call creates a new ticket or a new comment.

Annotations are advisory hints for clients deciding how to present or
re-execute a call. They are not access control: the allowlist and the OAuth
scopes are.

## Allowlist contract

`ZENDESK_ALLOWED_TOOLS` narrows the deployed tool surface to a named subset:

- Unset or empty, the allowlist itself restricts nothing, and all twelve
  tools are available (subject to `ZENDESK_READ_ONLY`, below).
- Set to a comma-separated list of tool names, only those tools are
  registered. A filtered tool does not appear in `tools/list`, and calls to it
  are refused. Each handler also re-checks the policy at call time, so a tool
  outside the allowlist cannot act even if it were somehow invoked.
- A value that names no tool, contains a duplicate, or contains an unknown
  name is rejected at startup: the server refuses to start and reports the
  problem, naming any offending tool names.

For example, a read-only deployment allows the nine read tools:

```sh
export ZENDESK_ALLOWED_TOOLS="zendesk_status,zendesk_search_tickets,\
zendesk_get_ticket,zendesk_list_brands,zendesk_list_groups,\
zendesk_list_users,zendesk_list_organizations,\
zendesk_list_ticket_fields,zendesk_list_ticket_forms"
```

`ZENDESK_READ_ONLY` expresses the same intent in one variable:

- Set to `1` or `true`, the surface is the nine read tools; the three write
  tools are not registered and their calls are refused.
- An explicit `ZENDESK_ALLOWED_TOOLS` still wins when it names only read
  tools, so a deployment can combine both: the allowlist's subset — which
  can be narrower than the nine read tools — is what is served.
- When read-only mode is on and the allowlist names a write tool, the server
  refuses to start and names the conflicting tools. Read-only mode never
  silently re-enables a write tool, and disabling it (`0`, `false`, or unset)
  restores the allowlist's usual meaning.
- Any other non-empty value is rejected at startup with `ZENDESK_READ_ONLY
  must be 1, true, 0, or false.` Accepted values are matched
  case-insensitively. An empty or whitespace-only value counts as
  unset per the trim rule, and so does a value that is exactly an
  unsubstituted `${...}` placeholder — read-only then stays off with no
  startup error.

The allowlist is a deployment control. It bounds what the server will offer;
OAuth scopes and the account's own role permissions bound what Zendesk will
allow. It complements those layers and does not replace them — for instance,
filtering out a list tool does not widen a token's scopes, and a token without
the matching scope still gets a `403` from Zendesk. The deployment model is in
[single-tenant-deployment.md](single-tenant-deployment.md#least-privilege-tool-allowlist).

## Audit contract

Every handled tool call emits exactly one audit event — read or write, success
or failure — as a single JSON line on stderr:

```json
{"event":"zendesk_tool_call","tool":"zendesk_get_ticket","operation":"read","outcome":"success","timestamp":"2026-01-02T03:04:05.000Z"}
```

The fields:

- `event`: always `zendesk_tool_call`.
- `tool`: the tool name.
- `operation`: `read` or `write`.
- `outcome`: `success` or `error`. A call that fails schema validation never
  reaches a handler and produces no event.
- `timestamp`: ISO 8601 UTC time of the event.
- `status`: the HTTP status, present on error events whose failure carries
  one.
- `actorId`: the authenticated Zendesk user's id. It is established by a
  successful `zendesk_status` call, so that call's own event — and any call
  before it — has no `actorId`; every later event does.

What the event deliberately excludes: ticket subjects, comment bodies, search
results, and any other ticket contents; credentials of any kind; and, on
errors, the response body — only the numeric `status` is recorded. The
connector also writes `server_start`, `server_shutdown`, and
`zendesk_oauth_logout` lifecycle lines to stderr; those are startup and
shutdown reporting, not part of the tool-call audit contract.

## Versioning policy

The connector's version is the package version, and the server reports it as
its MCP server version. The stability promise covers this surface:

- Tool names.
- Input fields: names, types, required-versus-optional status, defaults, and
  enum values listed above.
- Output fields documented above: names, types, and meanings — including the
  list envelope keys and `agent_url`.
- Error behavior: failed calls return `isError` results whose JSON carries
  `error`, plus `status` and `details` when applicable, without credentials.
- Audit events: the `zendesk_tool_call` name and the fields listed above.
- Allowlist behavior: valid tool names, startup validation, filtering
  semantics, and `ZENDESK_READ_ONLY` semantics as documented above.

It does not cover:

- Internal file layout or module organization.
- The wording of messages, including error messages.
- Log-line formatting outside the documented audit fields.
- Tool titles and descriptions as shown by clients.
- Fields passed through from the Zendesk API, which follow the account and the
  API version.

While the package is `0.x`:

- Additive changes — a new tool, a new optional input, a new output field —
  ship in a minor bump.
- Breaking changes — removing or renaming a tool, changing a required input,
  changing a documented output field's meaning or type — also ship in a minor
  bump during `0.x`, but must be called out as breaking in
  [CHANGELOG.md](../CHANGELOG.md) and in the root
  [README](../README.md).

After `1.0`:

- Additive changes are minor.
- Breaking changes are major.
- Fixes are patch.
