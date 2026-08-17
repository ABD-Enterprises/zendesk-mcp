# Zendesk MCP

An OAuth-only Model Context Protocol server for Zendesk Support, maintained by
[ABD Enterprises](https://github.com/ABD-Enterprises).

Zendesk MCP gives MCP-compatible clients a constrained set of tools to search,
read, create, and update support tickets. It does not accept Zendesk API-token
credentials or username/password authentication.

## Tools

| Tool | Access | Purpose |
| --- | --- | --- |
| `zendesk_status` | Read | Verify OAuth and identify the authenticated user |
| `zendesk_search_tickets` | Read | Search tickets with Zendesk search syntax |
| `zendesk_get_ticket` | Read | Read a ticket, users, organization, and comments |
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
  "scope": "tickets:read tickets:write users:read organizations:read"
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
tickets:read tickets:write users:read organizations:read
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
