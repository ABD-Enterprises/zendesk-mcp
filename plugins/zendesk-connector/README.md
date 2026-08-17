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

For an unattended server-to-server workflow, configure a confidential client and
set `ZENDESK_OAUTH_MODE=client_credentials`. The connector obtains and renews an
access token in memory; no browser setup or refresh-token file is used.

For a short-lived manually managed OAuth token, set
`ZENDESK_OAUTH_MODE=access_token` and `ZENDESK_OAUTH_ACCESS_TOKEN`. This mode
cannot renew expired tokens and is intended only for testing.

## Build

```sh
npm install
npm run build
```

## Tools

- `zendesk_status`: validates configuration and returns the authenticated user.
- `zendesk_search_tickets`: searches tickets with Zendesk search syntax.
- `zendesk_get_ticket`: reads a ticket with users, organization, and comments.
- `zendesk_create_ticket`: creates a ticket.
- `zendesk_update_ticket`: updates common ticket fields.
- `zendesk_add_ticket_comment`: adds a public reply or internal note.

All six tools use the same OAuth request layer. Use `zendesk_status` to verify
the authenticated user, OAuth mode, scope, and refresh capability.
