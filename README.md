# Zendesk MCP

An OAuth-only Model Context Protocol server for Zendesk Support, maintained by
[ABD Enterprises](https://github.com/ABD-Enterprises).

Zendesk MCP gives MCP-compatible clients a constrained set of tools to search,
read, create, and update support tickets. It does not accept Zendesk API-token
credentials or username/password authentication.

## Quickstart

The shortest path from a clean machine to a running server (requires
[Node.js 20 or newer](#requirements)):

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
`~/.config/codex-zendesk/client.json`, restricted to your user with
`chmod 600`), and run:

```sh
npm run oauth:setup
```

If a value is missing, the setup asks for it in a terminal — without one it
prints what is missing and exits 1 — and can store the answers in the same
owner-only `~/.config/codex-zendesk/client.json`, so exporting the variables
first is optional.

After configuring the OAuth client, or any time something is not working, run
the doctor preflight:

```sh
npm run doctor
```

It checks the configuration, the tool policy, the setup callback port, and the
stored token; each failing check prints one actionable line (details in
[Doctor preflight](#doctor-preflight)).

Point your MCP client at the built server as in
[Configure another MCP client](#configure-another-mcp-client), then verify the
configuration without starting the server:

```sh
node dist/index.js --healthcheck
```

A healthy result means the configuration is present and well-formed — the
first `zendesk_status` tool call is the real readiness check.

If anything fails, [Troubleshooting](#troubleshooting) maps the common errors
to their fixes. Before enabling the write tools against a production account,
consider starting with `ZENDESK_READ_ONLY=1`, or narrow the session further
with `ZENDESK_ALLOWED_TOOLS`, as described in the
[tool contracts](docs/tool-contracts.md).

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
| `zendesk_search_tickets` | Read | Search Zendesk with Zendesk search syntax |
| `zendesk_get_ticket` | Read | Read a ticket with users, organization, and comments |
| `zendesk_list_brands` | Read | List brands with page-based pagination |
| `zendesk_list_groups` | Read | List groups with page-based pagination |
| `zendesk_list_users` | Read | List users with page-based pagination |
| `zendesk_list_organizations` | Read | List organizations with page-based pagination |
| `zendesk_list_ticket_fields` | Read | List all ticket fields (one unpaginated response) |
| `zendesk_list_ticket_forms` | Read | List ticket forms with page-based pagination |
| `zendesk_create_ticket` | Write | Create a ticket |
| `zendesk_update_ticket` | Write | Update common ticket fields |
| `zendesk_add_ticket_comment` | Write | Add an internal note or public reply |

Internal notes are the default for `zendesk_add_ticket_comment`. A new
ticket's first comment is public unless `public: false` is passed, because it
is the ticket's description. Write tools are marked explicitly in their MCP
annotations.

**Breaking in the unreleased version:** `zendesk_search_tickets` now labels
every result with a `resultType` (`ticket`, `user`, `group` or
`organization`), and only a ticket result carries an `agent_url`. A user,
group or organization result no longer gets a ticket URL, so a consumer that
reads `agent_url` on every result must check `resultType` first. The
[tool contracts](docs/tool-contracts.md#agent_url) reference has the details.

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
means the base URL, OAuth mode, and credentials are set and well-formed and
the tool policy (`ZENDESK_ALLOWED_TOOLS` / `ZENDESK_READ_ONLY`) is valid — an
unset policy is valid, the defaults apply — not that any of it is correct or
that Zendesk is reachable, so use the `zendesk_status` tool for readiness.

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

These exports are optional: `npm run oauth:setup` (below) asks for any value it
cannot find — the subdomain, the client id, and the client secret — in a
terminal, and offers to save the answers to
`~/.config/codex-zendesk/client.json` with owner-only permissions. Without a
terminal it prints what is missing and exits 1 instead of prompting.

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

### Doctor preflight

The doctor runs the same configuration and tool-policy validation as startup
and adds the checks that only matter before the first request, without
contacting Zendesk:

- The OAuth configuration, including the owner-only permission requirement on
  the client file.
- The tool policy (`ZENDESK_READ_ONLY` and `ZENDESK_ALLOWED_TOOLS`).
- The setup callback port (`ZENDESK_OAUTH_CALLBACK_PORT`, default 3219): it
  must be decimal digits naming an integer from 1 to 65535 and free to bind
  on `127.0.0.1`. This check runs only in `authorization_code` mode and only
  when re-running setup is the remedy for the token problem — the file is
  missing, unparseable, or lacks a token field (a path or permission problem
  skips it), and setup needs the port.
- The stored token file in `authorization_code` mode: its path must not be
  the OAuth client file (setup's atomic write would replace the client
  credentials with the token), it must exist (a missing
  file is reported as "run `npm run oauth:setup`"), be a regular file, parse
  as JSON, and contain both an `access_token` and a `refresh_token` (renewal
  fails without one once the access token expires). It must also be readable
  only by its owner. The permission check is doctor-only; the server itself
  reads the token file without inspecting its permissions, and on Windows the
  doctor skips the check too, where Node reports synthetic permission bits
  regardless of the file's ACLs.

Run it with `npm run doctor` from `plugins/zendesk-connector` (the repository
root has no `package.json`), or directly with the built output:

```sh
node plugins/zendesk-connector/dist/index.js --doctor
```

The `npm run` form is for a git checkout: it rebuilds first, so it needs the
dev dependencies that `npm ci` installs. An installed package ships only
`dist` (no sources or `tsconfig`), so there the direct form is the only one —
`node node_modules/@abd-enterprises/zendesk-mcp/dist/index.js --doctor`, or
`zendesk-mcp --doctor` when the package's `bin` entry is on your `PATH`.

A clean run of the doctor prints one all-clear line on stdout and exits 0 —
`npm run --silent doctor` suppresses npm's own script banners, so exactly one
line reaches the shell. Each failing check is one actionable line on stderr
and the exit code is 1, so a script can gate on it. The configuration messages
and the token file's missing, unparseable, and incomplete messages are the
server's own error strings; the port and the token file-state messages (an
unreadable path, not a regular file, loose permissions) are the doctor's, and
nothing printed carries credential values.

An explicit command-line flag always wins over the environment-variable
shortcuts: `--doctor` (or `--logout`) runs its own mode even on a host that
exports `ZENDESK_HEALTHCHECK=1`. When two mode flags appear together, the
order is `--healthcheck`, then `--doctor`, then `--logout`.

### Healthcheck and shutdown

The server validates its OAuth configuration and tool policy and exits
without serving when it is started with `--healthcheck`, or with
`ZENDESK_HEALTHCHECK=1` (or `true`):

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
| `ZENDESK_ALLOWED_TOOLS` | All compiled tools | Comma-separated subset of tool names to serve |
| `ZENDESK_READ_ONLY` | | Set to `1` or `true` to serve only the nine read tools; a `ZENDESK_ALLOWED_TOOLS` value naming a write tool is then rejected at startup |
| `ZENDESK_SHUTDOWN_TIMEOUT_MS` | `5000` | Milliseconds before a hung shutdown is force-exited |

Secret storage and secret-manager patterns: [Secrets and storage](docs/secrets-and-storage.md).

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Zendesk connector is not configured. Set ZENDESK_SUBDOMAIN or ZENDESK_BASE_URL.` | No account identifier reached the server. Set `ZENDESK_SUBDOMAIN` (or `ZENDESK_BASE_URL`), or add `"subdomain"` (or `"baseUrl"`) to `~/.config/codex-zendesk/client.json`. Environment variables override the file. |
| `Zendesk OAuth is not configured. Set OAuth client credentials and run npm run oauth:setup...` | The OAuth client id and secret are missing. Set `ZENDESK_OAUTH_CLIENT_ID` and `ZENDESK_OAUTH_CLIENT_SECRET`, or add them to `client.json`. |
| `ZENDESK_OAUTH_CLIENT_ID and ZENDESK_OAUTH_CLIENT_SECRET are required for this OAuth mode.` | `ZENDESK_OAUTH_MODE` (in the environment or as `"mode"` in `client.json`) is set explicitly and either credential is missing. Set both values (environment or `client.json`) as in the row above. |
| `No refresh token found in ...`, `OAuth token file ... does not contain an access_token.`, or `Unable to read OAuth token file ...` | The authorization-code token store is missing, unparseable, or incomplete (an `access_token` the server needs to act, or the `refresh_token` that renews it). Run `npm run oauth:setup` again, and check `ZENDESK_OAUTH_TOKEN_FILE` if the file lives elsewhere. The doctor's variant ending `Check that the path exists and this user can access it.` means the file exists but this user cannot open it — fix its ownership or permissions instead of re-running setup (the port is not checked for it). |
| `OAuth token file ... is not a regular file.` | Something other than a file sits at the token path, usually a directory. Setup's atomic write cannot replace it, so remove the directory (or fix `ZENDESK_OAUTH_TOKEN_FILE`) instead of re-running setup; the doctor skips the port check because the repair needs no port. |
| `OAuth token file ... is the OAuth client file. Set ZENDESK_OAUTH_TOKEN_FILE to a different path...` | The resolved token path names the OAuth client file itself — usually because `ZENDESK_OAUTH_TOKEN_FILE` names the same file as `ZENDESK_OAUTH_CLIENT_FILE` (or as the default client path), and sometimes because the client file's own `tokenFile` field points at the client file. Re-running setup would replace the client credentials with the token, so point the token variable — or the field — at a different path instead; the doctor skips the port check because the repair needs no port. `--logout` refuses to delete the file for the same reason. |
| `OAuth client configuration ... must be readable only by its owner (chmod 600).` | The client file is accessible to group or others. Run `chmod 600 ~/.config/codex-zendesk/client.json` (or fix the file `ZENDESK_OAUTH_CLIENT_FILE` names). The connector skips this check on Windows, where Node reports synthetic permission bits regardless of the file's ACLs. |
| `OAuth client configuration ... has a "tokenFile" value that must be a non-empty path string.` | The `"tokenFile"` field in `client.json` holds a JSON value that is not a non-empty string (for example a number or `""`). Set it to an absolute path such as `/Users/you/.config/codex-zendesk/oauth.json` — the connector reads the field verbatim, does not expand `~`, and resolves a relative path against the server process's working directory, which the client that starts the server chooses — or remove the field to use the default (or `ZENDESK_OAUTH_TOKEN_FILE`). The doctor reports this as an ordinary configuration problem and skips the checks that depend on it; `--logout` reports it and still clears the local credentials. |
| `OAuth client configuration ... has a "baseUrl" value that must be a string.` (or `"subdomain"`) | The `"baseUrl"` or `"subdomain"` field in `client.json` holds a JSON value that is not a string (for example a number; `null` counts as wrong-typed, not unset). The field is checked where the file is read, so an environment variable that would override it does not rescue a wrong-typed value: fix the field, or remove it and use `ZENDESK_SUBDOMAIN` / `ZENDESK_BASE_URL`. |
| `ZENDESK_READ_ONLY must be 1, true, 0, or false.` | The read-only flag holds an unrecognized value. Set it to `1` (or `true`) to enable, `0` (or `false`) to disable, or unset it. |
| `ZENDESK_READ_ONLY conflicts with write tools in ZENDESK_ALLOWED_TOOLS: ...` | Read-only mode is on but the allowlist names write tools. Remove those names from `ZENDESK_ALLOWED_TOOLS`, or unset `ZENDESK_READ_ONLY` if writes are intended. |
| `OAuth token file ... must be readable only by its owner (chmod 600).` | Reported by the doctor as a failing check (exit 1): the token store is accessible to group or others. Run `chmod 600 ~/.config/codex-zendesk/oauth.json` (or fix the file `ZENDESK_OAUTH_TOKEN_FILE` names). The server itself does not check the token file's permissions, so only the doctor surfaces this. The doctor skips this check on Windows, where Node reports synthetic permission bits regardless of the file's ACLs. |
| `ZENDESK_OAUTH_CALLBACK_PORT must be an integer from 1 to 65535, written as decimal digits (for example 3219).` | Reported by the doctor and by `npm run oauth:setup`: the port variable does not parse as a port number. Set it to decimal digits naming an integer from 1 to 65535 (for example `3219`), or unset it to use the default. |
| `npm run oauth:setup` fails to listen on port 3219, or the doctor reports `npm run oauth:setup cannot listen on port 3219: another process holds the port ...` | Another process holds the port (often an earlier setup still waiting for authorization); the doctor reports this before setup runs whenever re-running setup is the remedy for the token problem — the token file is missing, unparseable, or lacks a token field (a path or permission problem skips the port check). Set `ZENDESK_OAUTH_CALLBACK_PORT` to a free port and register that exact callback URL on the OAuth client in Zendesk — the redirect URI must match. If the doctor instead reports `... this user cannot bind the port ...`, the OS refused the bind attempt itself — the errno it prints names the cause (a port below 1024 needs elevated privileges; a higher port can be refused by a sandbox, a firewall, or exhausted file descriptors) — no other process is holding it. |
| The browser opens but Zendesk reports an authorization error | Usually the OAuth client's registered callback URL does not exactly match `http://127.0.0.1:3219/callback` — or the URL for your `ZENDESK_OAUTH_CALLBACK_PORT`; scheme, host, port, and path all count. Correct it in Admin Center, run setup again, then restart the server so it picks up the fresh token. Declining consent or a declined scope produces the same symptom. |
| Tool calls fail with `Zendesk API request failed: HTTP 403 ...` | Usually the granted scope does not cover the tool, or the account's role lacks the underlying permission. Add the scope to `ZENDESK_OAUTH_SCOPE` (and, if the OAuth client has allowed scopes configured in Admin Center, add it there too — otherwise setup fails with `HTTP 400 invalid_scope`): authorization-code mode re-runs `npm run oauth:setup` so the larger grant replaces the stored token, client-credentials mode carries it on the next token request, and `access_token` mode cannot change it — obtain a token with the needed scope there. Then restart the server so it loads the new configuration. |
| A desktop MCP client reports "not configured" although your shell works | Desktop applications do not inherit shell exports. Put the settings in `~/.config/codex-zendesk/client.json`, which the server reads when the environment is empty. |
| You want to check the configuration without serving | Run `node dist/index.js --healthcheck` from `plugins/zendesk-connector` (or `node plugins/zendesk-connector/dist/index.js --healthcheck` from the repository root). Healthy means the configuration is present and well-formed and the tool policy is valid (an unset policy applies the defaults) — not that Zendesk is reachable or that authorization succeeded (see [Healthcheck and shutdown](#healthcheck-and-shutdown)); use `zendesk_status` for readiness. The check never contacts Zendesk and never prints credentials. |
| You want one diagnosis for the whole setup | Run `npm run doctor` from `plugins/zendesk-connector` (or `node plugins/zendesk-connector/dist/index.js --doctor` from the repository root; the script rebuilds first and needs the dev dependencies from `npm ci`, so a pruned install uses the direct form). It runs the healthcheck's validation and adds the setup-only checks: the callback port's validity and availability, and the stored token file's state (details in [Doctor preflight](#doctor-preflight)). One actionable line per failing check on stderr, exit 1; a single all-clear line on stdout, exit 0 (use `npm run --silent doctor` when counting lines — npm's own script banners are extra stdout lines). |

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
