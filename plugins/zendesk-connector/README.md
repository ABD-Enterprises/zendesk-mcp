# Zendesk MCP

OAuth-only MCP server and Codex plugin for Zendesk Support, maintained by ABD
Enterprises. See the public
[repository README](https://github.com/ABD-Enterprises/zendesk-mcp#readme) for
installation, configuration, security, and contribution guidance.

## Configure OAuth

API-token authentication is not supported. Create a confidential OAuth client in
Zendesk Admin Center under **Apps and integrations > APIs > OAuth clients**. Add
`http://127.0.0.1:3219/callback` as a redirect URL, then set:

```sh
export ZENDESK_SUBDOMAIN="your-subdomain"
export ZENDESK_OAUTH_CLIENT_ID="your-oauth-client-identifier"
export ZENDESK_OAUTH_CLIENT_SECRET="your-oauth-client-secret"
```

For deployments that should be read-only, set `ZENDESK_READ_ONLY=1`. To
narrow the surface further or name an explicit subset, add a tool allowlist:

```sh
export ZENDESK_READ_ONLY=1
# Or, instead, name the read tools explicitly:
# export ZENDESK_ALLOWED_TOOLS="zendesk_status,zendesk_search_tickets,zendesk_get_ticket,\
# zendesk_list_brands,zendesk_list_groups,zendesk_list_users,\
# zendesk_list_organizations,zendesk_list_ticket_fields,zendesk_list_ticket_forms"
```

Every tool call emits a structured audit event to stderr without ticket
contents or credentials. Once `zendesk_status` succeeds, events include the
authenticated Zendesk user ID. Calls made before that status check have no
actor ID. The allowlist is a deployment control; it should be combined with
Zendesk OAuth scopes and the account's own role permissions.

Codex desktop can instead read an owner-only
`~/.config/codex-zendesk/client.json` file containing `subdomain`, `mode`,
`clientId`, `clientSecret`, and `scope`. Environment variables override the
file. Restrict it with `chmod 600`.

Alternatively, set `ZENDESK_BASE_URL` to a full Zendesk URL such as
`https://your-subdomain.zendesk.com`.

Run the one-time authorization flow from this directory:

```sh
npm run oauth:setup
```

The browser flow stores access and rotating refresh tokens in
`~/.config/codex-zendesk/oauth.json` with owner-only permissions. The MCP server
refreshes expiring tokens and updates that file automatically. Override the file
with `ZENDESK_OAUTH_TOKEN_FILE` and scopes with `ZENDESK_OAUTH_SCOPE`.

Upgrading an installation whose access token predates the `brands:read` and
`groups:read` default scopes: re-run `npm run oauth:setup`, because that token
does not carry the two new scopes and the list tools return 403 until it is
renewed. If the OAuth client has allowed scopes configured, they must also
include the new pair — Zendesk rejects any other request with
`400 invalid_scope`. `client_credentials` mode picks the new scope up on its
next token request.

For an unattended server-to-server workflow, configure a confidential client and
set `ZENDESK_OAUTH_MODE=client_credentials`. The connector obtains and renews an
access token in memory; no browser setup or refresh-token file is used.

For a short-lived manually managed OAuth token, set
`ZENDESK_OAUTH_MODE=access_token` and `ZENDESK_OAUTH_ACCESS_TOKEN`. This mode
cannot renew expired tokens and is intended only for testing.

## Doctor preflight

The doctor diagnoses a setup without contacting Zendesk. Run it with:

```sh
npm run doctor
```

or directly with `node dist/index.js --doctor`. The `npm run` form is for a
git checkout: it rebuilds first, so it needs the dev dependencies that
`npm ci` installs. An installed package ships only `dist` (no sources or
`tsconfig`), so there the direct form is the only one —
`zendesk-mcp --doctor` when the package's `bin` entry is on your `PATH`.
It performs the [healthcheck](#healthcheck-and-shutdown) validation and adds
the checks that matter before the first request:

- The setup callback port (`ZENDESK_OAUTH_CALLBACK_PORT`, default 3219) parses
  as decimal digits naming an integer from 1 to 65535 and is free to bind on
  `127.0.0.1`. This runs only in `authorization_code` mode and only when
  re-running setup is the remedy for the token problem — the file is missing,
  unparseable, or lacks a token field (a path or permission problem skips it),
  and setup needs the port.
- The stored token file in `authorization_code` mode: it exists (a missing
  file means "run `npm run oauth:setup`"; a stat failure other than a missing
  path is reported with its own advice instead), is a regular file, parses
  as JSON, and contains both an `access_token` and a `refresh_token` (renewal
  fails without one once the access token expires). It must also be readable
  only by its owner. The permission check is doctor-only; the server reads the
  file without inspecting its permissions, and the doctor skips the check on
  Windows, where Node reports synthetic permission bits regardless of the
  file's ACLs.

A clean run prints one all-clear line on stdout and exits 0 — `npm run
--silent doctor` suppresses npm's own script banners, so exactly one line
reaches the shell. Each failing check is one actionable line on stderr and
the exit code is 1. The
configuration messages and the token file's missing, unparseable, and
incomplete messages are the server's own error strings; the port and the token
file-state messages (an unreadable path, not a regular file, loose
permissions) are the doctor's, and nothing printed carries credential values.
An explicit `--doctor` or `--logout` flag wins over the `ZENDESK_HEALTHCHECK`
environment-variable shortcut.

## Healthcheck and shutdown

Validate the OAuth configuration and tool policy without contacting Zendesk
and without serving:

```sh
node dist/index.js --healthcheck
```

`ZENDESK_HEALTHCHECK=1` (or `true`) selects the same mode. A valid
configuration prints `{"healthcheck":"ok"}` on stdout and exits 0. A missing or
invalid one prints `{"healthcheck":"fail","error":"..."}` on stderr and exits
1. The reason comes from the configuration error: it never contains credential
material, and it can name the client-file path it could not read.

`SIGINT` and `SIGTERM` close the server and exit 0, or 1 if closing fails. A
second signal exits immediately with 130 or 143, and a shutdown that hangs is
force-exited with code 1 after `ZENDESK_SHUTDOWN_TIMEOUT_MS` milliseconds
(default 5000). The server writes `server_start` and `server_shutdown` events to
stderr, without credential material.

## Build

```sh
npm install
npm run build
```

### Container

```sh
docker build -t zendesk-mcp ./plugins/zendesk-connector
docker run --rm -i \
  -e ZENDESK_SUBDOMAIN=your-subdomain \
  -e ZENDESK_OAUTH_MODE=client_credentials \
  -e ZENDESK_OAUTH_CLIENT_ID \
  -e ZENDESK_OAUTH_CLIENT_SECRET \
  zendesk-mcp
```

For authorization-code deployments, mount the owner-only OAuth client and token
files rather than placing secrets in the image.

The image healthcheck runs `node dist/index.js --healthcheck`, so the container
reports unhealthy until the OAuth configuration is present. Healthy means the
base URL, OAuth mode, and credentials (or, in access-token mode, the token)
are set and well-formed and the tool policy is valid — an unset policy is
valid, the defaults apply — not that any of it is correct, that the
authorization-code token file is readable, or that Zendesk is reachable, so use
the `zendesk_status` tool for readiness.

## End-to-end tests

The end-to-end harness (`e2e/run-e2e.mjs`) spawns the built server
(`dist/index.js`) and speaks MCP over its stdio, asserting real request to
response behavior for the read-only surface: `zendesk_status`, the list tools,
`zendesk_search_tickets`, and — when `ZENDESK_E2E_TICKET_ID` names a ticket —
`zendesk_get_ticket`. The harness never calls a write tool, never prints token
values, and always relocates `ZENDESK_OAUTH_CLIENT_FILE` and
`ZENDESK_OAUTH_TOKEN_FILE` to a private temporary directory, so a run never
reads the invoking host's `~/.config/codex-zendesk` files.

```sh
npm run e2e:mock
```

This suite is hermetic: it drives the harness against a local `node:http`
mock Zendesk and needs no account, no network access, and no credentials. It
also covers the unconfigured skip path. Run `npm run build` first so
`dist/index.js` exists.

```sh
ZENDESK_SUBDOMAIN=your-sandbox-subdomain \
ZENDESK_OAUTH_ACCESS_TOKEN=... \
ZENDESK_E2E_TICKET_ID=123 \
npm run e2e
```

Point `npm run e2e` at a disposable sandbox with `ZENDESK_BASE_URL` (or
`ZENDESK_SUBDOMAIN`) and `ZENDESK_OAUTH_ACCESS_TOKEN`; `ZENDESK_E2E_TICKET_ID`
is optional. When those variables are unset the harness prints a clear skip
message and exits 0. The harness is read-only: whatever the account allows,
this phase only calls read tools.

A live run needs an owner-provided disposable sandbox account and is never
part of `npm run check` or CI.

## Tools

- `zendesk_status`: validates configuration and returns the authenticated user.
- `zendesk_search_tickets`: searches tickets with Zendesk search syntax.
- `zendesk_get_ticket`: reads a ticket with users, organization, and comments.
- `zendesk_list_brands`: lists brands with page-based pagination.
- `zendesk_list_groups`: lists groups with page-based pagination.
- `zendesk_list_users`: lists users with page-based pagination.
- `zendesk_list_organizations`: lists organizations with page-based pagination.
- `zendesk_list_ticket_fields`: lists all ticket fields (one unpaginated
  response).
- `zendesk_list_ticket_forms`: lists ticket forms with page-based pagination.
- `zendesk_create_ticket`: creates a ticket.
- `zendesk_update_ticket`: updates common ticket fields.
- `zendesk_add_ticket_comment`: adds a public reply or internal note.

All twelve tools use the same OAuth request layer. Use `zendesk_status` to verify
the authenticated user, OAuth mode, scope, and refresh capability.
