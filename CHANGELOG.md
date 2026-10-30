# Changelog

## Unreleased

- **Breaking:** `zendesk_search_tickets` now labels every result with a
  `resultType` field (`ticket`, `user`, `group` or `organization`), and only a
  ticket result carries an `agent_url`. A non-ticket result no longer gets a
  ticket URL, so a consumer that reads `agent_url` on every result must check
  `resultType` first.
- `zendesk_get_ticket` now asks Zendesk for the comment authors it always
  promised, returns the comment page named by the new `commentPage` input, and
  reports `commentPage`, `commentsTruncated`, `commentsNextPage` and
  `commentsNextPageNumber` so a truncated thread has a continuation the tool
  can actually take.
- `zendesk_update_ticket` refuses an empty `tags` array instead of sending it
  to Zendesk, where it would remove every tag on the ticket.
- `zendesk_create_ticket` takes a `public` flag (default true) and sends it
  with the ticket's first comment, so the comment's visibility no longer
  depends on a Zendesk-side default.
- The write tools say what they do: `zendesk_update_ticket` and
  `zendesk_add_ticket_comment` are marked `destructiveHint: true`, and the
  three write-tool descriptions name their result shape, describe their
  fields, and say what the tool cannot do.

## 0.6.1

- Add a reusable OIDC trusted-publishing workflow
  (`.github/workflows/npm-publish.yml`) that publishes the connector to npm
  with provenance and no stored token. The release workflow calls it for
  every `v*` tag, gated behind the operator-only `NPM_TRUSTED_PUBLISHING` repo
  variable. It preserves the release invariants: tag/package version match,
  packed-entry-and-imports verification, an executable smoke test, and a
  provenance dry-run before the real publish.
- Add an interactive `npm run oauth:setup` flow that guides a first-time OAuth
  setup, prompting for any missing subdomain, client id, or client secret and
  completing the browser authorization against the account's loopback callback.
- Add a `npm run doctor` preflight command that validates the OAuth
  configuration and reports what is missing before serving.
- Add `ZENDESK_READ_ONLY=1` to serve only the read-only tools, plus a
  read-only end-to-end sandbox harness.
- Add read-only `zendesk_list_ticket_fields` and `zendesk_list_ticket_forms`
  tools.
- Add a README quickstart and troubleshooting table.
- Update the roadmap position, tool and retention counts, isolation phase-2
  guidance, and the 0.6.0 release record.

## 0.6.0

- Add OAuth logout and token revocation: a new connector entry point revokes
  the live OAuth token, removes the stored token file, and emits an audit
  event.
- Add four read-only list tools — `zendesk_list_brands`,
  `zendesk_list_groups`, `zendesk_list_organizations`, and
  `zendesk_list_users` — and extend the deployment allowlist accordingly.
- Extend test coverage with search pagination, and with groups and users in
  the list pagination suite.
- Document secrets and storage guidance, plus data retention and incident
  response policies, in `SECURITY.md`.
- Add an operations guide for the console and connector, and a single-tenant
  deployment guide including its day-2 subsections: backup, upgrades,
  monitoring, and incident response.
- Add a tool-contract reference for every MCP tool (`docs/tool-contracts.md`).
- Fix three recorded documentation contradictions and the stale roadmap
  bullet.
- Add the multi-user OAuth isolation design document
  (`docs/multi-user-oauth-isolation.md`); it is design-only and changes no
  code.
- CI: generate a CycloneDX SBOM for the connector and run a dependency-review
  job on pull requests.
- Update `react` and `react-dom` in the operations console.

## 0.5.0

- Add graceful shutdown: `SIGINT` and `SIGTERM` close the server and exit 0 (or
  1 if closing fails), a second signal exits immediately with 130 or 143, and a
  watchdog force-exits a hung shutdown with code 1 after
  `ZENDESK_SHUTDOWN_TIMEOUT_MS` (default 5000).
- Add `--healthcheck` (`ZENDESK_HEALTHCHECK=1` or `true`) to validate the OAuth
  configuration without serving and without contacting Zendesk, and add the
  matching Docker `HEALTHCHECK`.
- Emit structured `server_start` and `server_shutdown` events to stderr for
  process lifecycle, reusing the existing redaction; the `zendesk_tool_call`
  audit event is unchanged.
- Single-source the connector version from `package.json`, feeding the MCP
  server info and the HTTP user agent.
- Add a CI job that type-checks, builds, and audits
  `apps/operations-console`, and scrub live-account data from the repository
  tree: the console reads its account identifiers from `ZENDESK_CONSOLE_*`
  environment variables (see `apps/operations-console/.env.example`).
- Update dependencies, including the fixes for the `body-parser` and connector
  lockfile advisories.
- Publish container images to `ghcr.io/abd-enterprises/zendesk-mcp:<version>`
  automatically when a version tag is pushed, guarded by a fail-closed
  overwrite preflight: only a registry answer that positively reports the
  manifest as unknown proceeds, and every other answer aborts the release
  before any build or push.
- Rate-limit the file-serving routes of the operations console with
  `express-rate-limit`: 300 requests per minute per client address by default,
  overridable through `ZENDESK_CONSOLE_RATE_LIMIT` and
  `ZENDESK_CONSOLE_RATE_LIMIT_WINDOW_MS`. The console also ships an automated
  test suite, which CI runs.
- Document the real publish flow and concrete rollback steps in
  `docs/release-checklist.md`, including a leaked-credential procedure that
  starts by revoking the credential before anything else.

## 0.4.0

- Add deployment-configurable MCP tool allowlists.
- Emit structured, content-free audit events for tool calls.
- Redact secret-like fields from Zendesk error details.
- Add a multi-stage Docker image and container usage guidance.
- Document the product roadmap and organizational deployment gaps.
