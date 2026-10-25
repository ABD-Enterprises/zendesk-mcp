# Changelog

## Unreleased

No changes recorded yet.

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
