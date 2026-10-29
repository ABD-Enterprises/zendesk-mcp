# Zendesk MCP

An OAuth-only Model Context Protocol server for Zendesk Support, maintained by
[ABD Enterprises](https://github.com/ABD-Enterprises).

Zendesk MCP gives MCP-compatible clients a constrained set of tools to search,
read, create, and update support tickets. It does not accept Zendesk API-token
credentials or username/password authentication.

## Quickstart

The shortest path from a clean machine to a running server:

```sh
git clone https://github.com/ABD-Enterprises/zendesk-mcp.git
cd zendesk-mcp/plugins/zendesk-connector
npm ci
npm run build
```

Then, once per account (details in
[Configure Zendesk OAuth](#configure-zendesk-oauth)): create a confidential
OAuth client in Zendesk Admin Center with the callback URL
`http://127.0.0.1:3219/callback`, set `ZENDESK_SUBDOMAIN`,
`ZENDESK_OAUTH_CLIENT_ID`, and `ZENDESK_OAUTH_CLIENT_SECRET` (or store them in
`~/.config/codex-zendesk/client.json`), and run:

```sh
npm run oauth:setup
```

Point your MCP client at the built server as in
[Configure another MCP client](#configure-another-mcp-client), then verify the
configuration without starting the server:

```sh
node dist/index.js --healthcheck
```

If anything fails, [Troubleshooting](#troubleshooting) maps the common errors
to their fixes. Before enabling the write tools against a production account,
consider limiting the session to the read tools with `ZENDESK_ALLOWED_TOOLS`
as described in the [tool contracts](docs/tool-contracts.md).

## Service Operations console

The repository also includes a local back-office application for the service
desk workflows around the connector. It provides live queue health, native
Zendesk report links, intake architecture, knowledge-pipeline tracking, and
readiness controls while keeping existing intake configuration read-only. It is
a reference application: no account data is stored in this repository.

```sh
cd apps/operations-console
npm install
npm run dev
```

Open `http://127.0.0.1:4177`. The server reads the existing owner-only Zendesk
OAuth client configuration from `~/.config/codex-zendesk/client.json`. OAuth
credentials and access tokens are never returned to the browser.

The account identifiers the console needs come from environment variables, so
the same build works against any account:

| Variable | Description |
| --- | --- |
| `ZENDESK_CONSOLE_BRAND_ID` | Brand the console is scoped to |
| `ZENDESK_CONSOLE_REQUEST_TYPE_FIELD_ID` | Ticket field that carries the request type |
| `ZENDESK_CONSOLE_SYSTEM_FIELD_ID` | Ticket field that carries the system |
| `ZENDESK_CONSOLE_VIEW_OPEN_ID` | View id for the open queue |
| `ZENDESK_CONSOLE_VIEW_UNTRIAGED_ID` | View id for the untriaged queue |
| `ZENDESK_CONSOLE_VIEW_AGING_ID` | View id for the aging report |
| `ZENDESK_CONSOLE_VIEW_REQUEST_TYPE_ID` | View id for the request-type report |

See [`apps/operations-console/.env.example`](apps/operations-console/.env.example)
for a template. When a variable is missing, the console reports the missing
names instead of guessing an account.

For reverse-proxy, TLS, backup, recovery, upgrade, and rollback guidance, see
the [operations guide](docs/operations.md). For the supported deployment
shape, configuration precedence, and explicit non-goals, see the
[single-tenant deployment guide](docs/single-tenant-deployment.md).

## Tools

The full contract for every tool — inputs, result envelopes, errors, audit
events, the allowlist, and the versioning policy — is in the
[tool contracts](docs/tool-contracts.md) reference.

| Tool | Access | Purpose |
| --- | --- | --- |
| `zendesk_status` | Read | Verify OAuth and identify the authenticated user |
| `zendesk_search_tickets` | Read | Search tickets with Zendesk search syntax |
| `zendesk_get_ticket` | Read | Read a ticket, users, organization, and comments |
| `zendesk_list_brands` | Read | List brands with page-based pagination |
| `zendesk_list_groups` | Read | List groups with page-based pagination |
| `zendesk_list_users` | Read | List users with page-based pagination |
| `zendesk_list_organizations` | Read | List organizations with page-based pagination |
| `zendesk_list_ticket_fields` | Read | List all ticket fields (one unpaginated response) |
| `zendesk_list_ticket_forms` | Read | List ticket forms with page-based pagination |
| `zendesk_create_ticket` | Write | Create a ticket |
| `zendesk_update_ticket` | Write | Update common ticket fields |
| `zendesk_add_ticket_comment` | Write | Add an internal note or public reply |

Internal notes are the default for comments. Write tools are marked explicitly
in their MCP annotations.

## Requirements

- Node.js 20 or newer
- A Zendesk Support account
- A confidential Zendesk OAuth client

## Install from GitHub

```sh
git clone https://github.com/ABD-Enterprises/zendesk-mcp.git
cd zendesk-mcp/plugins/zendesk-connector
npm ci
npm run build
```

### Install as a Codex plugin

From the repository root:

```sh
codex plugin marketplace add "$PWD"
codex plugin add zendesk-connector@abd-enterprises
```

The plugin bundles a local STDIO MCP server. Restart the Codex client after
installation.

### Configure another MCP client

Use Node.js to start the built server from its absolute path:

```json
{
  "mcpServers": {
    "zendesk": {
      "command": "node",
      "args": ["/absolute/path/to/zendesk-mcp/plugins/zendesk-connector/dist/index.js"]
    }
  }
}
```

Pass the OAuth environment variables described below through your MCP client's
environment configuration.

## Container image

Every released version publishes a container image to GitHub Container
Registry. The image tag is the version without its leading `v`, so the image
reference follows this pattern:

```text
ghcr.io/abd-enterprises/zendesk-mcp:<version>
```

Images are published per version tag only. The release workflow does not
publish a `latest` tag, so pull the version you intend to run:

```sh
docker pull ghcr.io/abd-enterprises/zendesk-mcp:<version>
```

The image entrypoint is the STDIO MCP server, so keep stdin attached and map
the OAuth environment variables listed in [Configuration](#configuration):

```sh
docker run --rm -i \
  -e ZENDESK_SUBDOMAIN=your-subdomain \
  -e ZENDESK_OAUTH_MODE=client_credentials \
  -e ZENDESK_OAUTH_CLIENT_ID=your-client-identifier \
  -e ZENDESK_OAUTH_CLIENT_SECRET=your-client-secret \
  ghcr.io/abd-enterprises/zendesk-mcp:<version>
```

`ZENDESK_SUBDOMAIN` (or `ZENDESK_BASE_URL`) and the OAuth credentials are
required; the configuration check fails without them. `ZENDESK_OAUTH_MODE`
selects the flow: `client_credentials` above, or `authorization_code` with a
mounted token file.

The image healthcheck runs `node dist/index.js --healthcheck`, so the
container reports unhealthy until the OAuth configuration is present. Healthy
means the base URL, OAuth mode, and credentials are set and well-formed, not
that they are correct or that Zendesk is reachable, so use the
`zendesk_status` tool for readiness.

For authorization-code deployments, mount the owner-only OAuth client and
token files instead of placing secrets in the image:

```sh
docker run --rm -i \
  -e ZENDESK_SUBDOMAIN=your-subdomain \
  -e ZENDESK_OAUTH_CLIENT_FILE=/secrets/client.json \
  -e ZENDESK_OAUTH_TOKEN_FILE=/secrets/oauth.json \
  -v "$HOME/.config/codex-zendesk:/secrets" \
  ghcr.io/abd-enterprises/zendesk-mcp:<version>
```

The container runs as the unprivileged `node` user, so the mounted client
file must be readable by it and the token file writable by it.

To build the image from source instead, see the connector's
[Container instructions](plugins/zendesk-connector/README.md#container).

## Configure Zendesk OAuth

Create a confidential OAuth client in Zendesk Admin Center under **Apps and
integrations > APIs > OAuth clients**. Register this callback URL:

```text
http://127.0.0.1:3219/callback
```

Set the client credentials locally:

```sh
export ZENDESK_SUBDOMAIN="your-subdomain"
export ZENDESK_OAUTH_CLIENT_ID="your-client-identifier"
export ZENDESK_OAUTH_CLIENT_SECRET="your-client-secret"
```

For desktop clients that do not inherit shell environment variables, store the
same settings in `~/.config/codex-zendesk/client.json`:

```json
{
  "subdomain": "your-subdomain",
  "mode": "authorization_code",
  "clientId": "your-client-identifier",
  "clientSecret": "your-client-secret",
  "scope": "tickets:read tickets:write users:read organizations:read brands:read groups:read"
}
```

Restrict the file to the current user with `chmod 600`. Environment variables
override values from this file.

Run the one-time browser authorization flow:

```sh
cd plugins/zendesk-connector
npm run oauth:setup
```

Access and rotating refresh tokens are stored at
`~/.config/codex-zendesk/oauth.json` with owner-only permissions. The server
refreshes expiring access tokens automatically and replaces rotated refresh
tokens atomically.

The default least-privilege scopes are:

```text
tickets:read tickets:write users:read organizations:read brands:read groups:read
```

Override them with `ZENDESK_OAUTH_SCOPE` when your workflow needs a different
set.

### Unattended service workflow

For a confidential server-to-server client, set:

```sh
export ZENDESK_OAUTH_MODE="client_credentials"
```

The server obtains access tokens in memory and requests a new token after
expiration or an authorization failure. Zendesk does not issue refresh tokens
for this flow.

### Manually managed OAuth access token

For testing, you can provide an existing OAuth access token:

```sh
export ZENDESK_OAUTH_MODE="access_token"
export ZENDESK_OAUTH_ACCESS_TOKEN="your-oauth-access-token"
```

This remains OAuth authentication, but the server cannot renew the token.

### Healthcheck and shutdown

The server validates its OAuth configuration and exits without serving when it
is started with `--healthcheck`, or with `ZENDESK_HEALTHCHECK=1` (or `true`):

```sh
node plugins/zendesk-connector/dist/index.js --healthcheck
```

A valid configuration prints `{"healthcheck":"ok"}` on stdout and exits 0. A
missing or invalid one prints `{"healthcheck":"fail","error":"..."}` on stderr
and exits 1. The check never contacts Zendesk and never prints credential
material; the failure reason can name the client-file path it could not read.

`SIGINT` and `SIGTERM` close the server and exit 0, or 1 if closing fails. A
second signal exits immediately with 130 or 143, and a shutdown that hangs is
force-exited with code 1 after `ZENDESK_SHUTDOWN_TIMEOUT_MS` milliseconds. The
server writes `server_start` and `server_shutdown` events to stderr.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `ZENDESK_SUBDOMAIN` | | Zendesk subdomain |
| `ZENDESK_BASE_URL` | | Full HTTPS Zendesk URL; overrides subdomain |
| `ZENDESK_OAUTH_MODE` | `authorization_code` | `authorization_code`, `client_credentials`, or `access_token` |
| `ZENDESK_OAUTH_CLIENT_ID` | | OAuth client identifier |
| `ZENDESK_OAUTH_CLIENT_SECRET` | | Confidential OAuth client secret |
| `ZENDESK_OAUTH_ACCESS_TOKEN` | | Existing OAuth token for `access_token` mode |
| `ZENDESK_OAUTH_CLIENT_FILE` | `~/.config/codex-zendesk/client.json` | Owner-only confidential client configuration |
| `ZENDESK_OAUTH_TOKEN_FILE` | `~/.config/codex-zendesk/oauth.json` | Authorization-code token store |
| `ZENDESK_OAUTH_SCOPE` | Least-privilege ticket scopes | Space-separated Zendesk scopes |
| `ZENDESK_OAUTH_CALLBACK_PORT` | `3219` | Local setup callback port |
| `ZENDESK_MAX_RETRIES` | `2` | Automatic `429` retries, from 0 to 5 |
| `ZENDESK_MAX_RETRY_DELAY_MS` | `10000` | Maximum automatic rate-limit wait |
| `ZENDESK_HEALTHCHECK` | | Set to `1` or `true` to validate the configuration and exit instead of serving |
| `ZENDESK_SHUTDOWN_TIMEOUT_MS` | `5000` | Milliseconds before a hung shutdown is force-exited |

Secret storage and secret-manager patterns: [Secrets and storage](docs/secrets-and-storage.md).

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Zendesk connector is not configured. Set ZENDESK_SUBDOMAIN or ZENDESK_BASE_URL.` | No account identifier reached the server. Set `ZENDESK_SUBDOMAIN`, or add `"subdomain"` to `~/.config/codex-zendesk/client.json`. Environment variables override the file. |
| `Zendesk OAuth is not configured. Set OAuth client credentials and run npm run oauth:setup...` | The OAuth client id and secret are missing. Set `ZENDESK_OAUTH_CLIENT_ID` and `ZENDESK_OAUTH_CLIENT_SECRET`, or add them to `client.json`. |
| `No refresh token found in ...` or `Unable to read OAuth token file ...` | The authorization-code token store is missing or unreadable. Run `npm run oauth:setup` again, and check `ZENDESK_OAUTH_TOKEN_FILE` if the file lives elsewhere. |
| `npm run oauth:setup` fails to listen on port 3219 | Another process holds the port (often an earlier setup still waiting for authorization). Set `ZENDESK_OAUTH_CALLBACK_PORT` to a free port and register that exact callback URL on the OAuth client in Zendesk — the redirect URI must match. |
| The browser opens but Zendesk reports an authorization error | The OAuth client's registered callback URL does not exactly match `http://127.0.0.1:3219/callback` (scheme, host, port, and path all count). Correct it in Admin Center and run setup again. |
| Tool calls fail with `Zendesk API request failed: HTTP 403 ...` | Usually the granted scope does not cover the tool. Add the scope to `ZENDESK_OAUTH_SCOPE` and re-run `npm run oauth:setup` so the larger grant replaces the stored token. |
| A desktop MCP client reports "not configured" although your shell works | Desktop applications do not inherit shell exports. Put the settings in `~/.config/codex-zendesk/client.json`, which the server reads when the environment is empty. |
| You want to check the configuration without serving | Run `node dist/index.js --healthcheck`. It validates configuration and exits; it never contacts Zendesk and never prints credentials. |

## Development

```sh
cd plugins/zendesk-connector
npm ci
npm run check
npm pack --dry-run
```

The tests use mock HTTP responses and in-memory MCP transports. They do not
require a Zendesk account.

## Security

Do not commit OAuth client secrets, access tokens, refresh tokens, or token
files. See [SECURITY.md](SECURITY.md) for vulnerability reporting and the
project's credential-handling policy.

## Project status

This project is under active development. Review tool permissions and test in a
Zendesk sandbox before enabling write tools against a production account.

## License

MIT. See [LICENSE](LICENSE).

Zendesk is a trademark of Zendesk, Inc. This project is independently maintained
by ABD Enterprises and is not affiliated with or endorsed by Zendesk, Inc.
