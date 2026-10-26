# Security Policy

## Reporting a vulnerability

Report security issues through GitHub's private vulnerability reporting for
`ABD-Enterprises/zendesk-mcp`. Do not open a public issue for suspected
credential exposure, authentication bypasses, or vulnerabilities that could
modify or disclose Zendesk data.

Include the affected version, reproduction steps, impact, and any suggested
mitigation. ABD Enterprises will acknowledge a report after triage and will
coordinate disclosure when a fix is available.

## Credential handling

- Zendesk API-token and password authentication are not supported.
- OAuth client secrets never live in code or in files inside the repository;
  they are supplied through the environment or through the owner-only client
  file, and environment variables take precedence.
- Authorization-code tokens are stored outside the repository with owner-only
  file permissions.
- Tool output must never include access tokens, refresh tokens, or client
  secrets.
- Production deployments should use a dedicated OAuth client and the minimum
  scopes required by the enabled tools.

If credentials may have been exposed, revoke them in Zendesk immediately and
complete the authorization flow again.

## Data retention

What is retained, where, by whom, and for how long, per class of data:

- Zendesk ticket and user data: the connector transfers tickets, comments,
  users, organizations, brands, and groups live during tool calls and keeps
  no copy locally; neither the connector nor the operations console has a
  datastore on disk (`docs/operations.md`, "No datastore to back up").
  Whatever an MCP client or an operator's log sink keeps is chosen there and
  is outside this repository's control. Retention inside the Zendesk account
  is the account's own concern.
- OAuth tokens and the client file: in `authorization_code` mode, tokens
  are stored in the owner-only `~/.config/codex-zendesk/oauth.json` (the
  path can be moved with `ZENDESK_OAUTH_TOKEN_FILE`), refresh tokens
  rotate on use, and logout reports the stored credentials as removed or
  as kept when the file is the OAuth client file itself. If exposure is
  suspected, follow "Credential handling" above: revoke in Zendesk
  immediately. This section references those steps rather than repeating
  them.
- Audit events: write-tool activity emits JSON lines on stderr with no
  ticket contents or credentials (`plugins/zendesk-connector/README.md`).
  Where those lines go and how long they are kept is the operator's sink
  policy. Example windows, which the owner confirms rather than commits
  to: 30 days for a development sink, 90 days for a production sink.
- Operations console: no persistent store; it makes live read requests and
  keeps no ticket data on disk.
- CI: the `connector-sbom` artifact is uploaded with an explicit 30-day
  retention (`retention-days: 30` in `.github/workflows/ci.yml`); other
  workflow logs and artifacts follow the repository's GitHub retention
  settings.
- Boundary: the connector deletes nothing on a schedule. This section sets
  operator expectations for data held outside this repository; it describes
  no automated deletion or expiry.

## Incident response

An incident here is one of the following:

- Exposed or stolen OAuth tokens, the OAuth client secret, or the client
  file.
- An unauthorized write made through a write tool (`zendesk_create_ticket`,
  `zendesk_update_ticket`, `zendesk_add_ticket_comment`).
- A tampered dependency or release artifact.
- Ticket data leaked through a log sink.

Contact: report through GitHub's private vulnerability reporting for
`ABD-Enterprises/zendesk-mcp`, the channel named under "Reporting a
vulnerability" above. Owner-defined placeholder contact:
`security@example.invalid`, a reserved example address the owner replaces
with a real monitored contact; this repository names no person or address.

Response steps, in order:

1. Detect and triage: confirm what happened, which data and tools were
   involved, and when it started.
2. Contain: revoke the OAuth tokens in Zendesk, stop the server, narrow
   `ZENDESK_ALLOWED_TOOLS` to the read-only tools only, and rotate the
   OAuth client secret. An empty or unset value enables every compiled
   tool, including the write tools, so never rely on it to deny access.
3. Assess: determine which read tools could have exposed which data; use
   the audit lines on stderr and Zendesk's own audit log as evidence
   sources.
4. Notify: reply to the reporter through the existing channel; any
   account-side notification is the owner's decision.
5. Recover: re-run the OAuth flow and verify with `zendesk_status` before
   returning to service.
6. Learn: record the cause and update this document or the code.

Severity and the response windows below are examples the owner sets, not a
service-level commitment:

| Severity | Example                             | Example response window |
| -------- | ----------------------------------- | ----------------------- |
| High     | Exposed or stolen credentials       | 24 hours                |
| Medium   | Any other incident listed above     | 72 hours                |
