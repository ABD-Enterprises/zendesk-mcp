# Zendesk MCP Product Roadmap

## Current position

The repository is an OAuth-only local MCP server for Zendesk Support. It
currently provides status validation, ticket search, ticket reads, ticket
creation, ticket updates, ticket comments, read-only lists of brands,
groups, users, organizations, ticket fields, and ticket forms, plus a
local service-operations console.

It is not yet an organization-ready shared service. Authorization policy,
auditability, deployment, and release engineering have shipped; the largest
gaps are multi-user OAuth isolation (a design in
`docs/multi-user-oauth-isolation.md`), broader Zendesk resource coverage
beyond the landed tools, a live run of the read-only end-to-end harness
against a disposable Zendesk sandbox, signed release artifacts, and the
independent security review that v1.0 requires.

Customer-specific brands, groups, dashboard IDs, ticket counts, URLs, and
operational handoff notes belong in a customer deployment or private operations
repository, not in the public connector package.

## Product direction

The primary product is a secure Zendesk MCP server. The operations console is
an optional reference application and should not be required to run the MCP
server.

The product remains OAuth-only. API-token and password authentication are out
of scope.

## Roadmap

### v0.4: Public-project baseline

- Remove customer-specific configuration from general product documentation.
- Resolve package, repository, author, and runtime user-agent branding.
- Add CI for typecheck, tests, package validation, and dependency checks.
- Add a Docker build to CI and audit production dependencies.
- Add a changelog and release process.
- Add issue intake templates and a release checklist.
- Add configuration validation and clearer startup diagnostics.
- Document local Codex installation and supported OAuth scopes.
- Add generic examples for local use and server deployment.

### v0.5: Security and governance

- Add a policy layer for read versus write tools.
- Add deployment-configurable tool allowlists.
- Add structured audit events for every write operation.
- Attribute audit events to the authenticated Zendesk user after connection
  status is established.
- Redact credentials, tokens, and sensitive ticket content from logs and errors.
- Improve OAuth refresh-token rotation, revocation, logout, and concurrent
  refresh handling.
- Add tests for scope failures, 401/429 responses, pagination, and secret
  redaction.

### v0.6: Organizational deployment

- Provide a supported Docker image.
- Document secret-manager integration and encrypted persistent token storage.
- Add reverse-proxy/TLS, backup, recovery, upgrade, and rollback guidance.
- The supported single-tenant deployment model is defined in
  `docs/single-tenant-deployment.md`; any multi-tenant hosting work comes
  only after that model.

### v0.7: Zendesk resource coverage

- Extend brands, groups, users, and organizations beyond their existing
  read-only lists.
- Add views, triggers, macros, automations, and SLA resources.
- Add Guide categories, sections, and articles.
- Investigate and add supported Explore dashboard/report operations where the
  Zendesk API exposes them; otherwise document the browser-only boundary.
- Keep each module's OAuth scopes and read/write behavior explicit.

### v1.0: Supported product

- Stabilize MCP tool contracts and versioning.
- Publish security, privacy, data-retention, and incident-response policies.
- Add signed release artifacts.
- Complete end-to-end tests against a disposable Zendesk sandbox.
- Publish migration and breaking-change documentation.
- Complete an independent security review before recommending production use.

## Buildable today

The following work can be completed in the current repository without needing
new Zendesk credentials or customer-side configuration:

1. Design the resource modules for the Zendesk resources that are not yet
   in the tool set (views, triggers, macros, automations, SLA policies,
   and Guide content), specifying each module's OAuth scopes and
   read/write behavior without enabling untested production writes.
2. Extend the brands, groups, users, and organizations tools beyond their
   existing read-only lists.
3. Investigate the Explore dashboard and report surface and write up the
   browser-only boundary where the Zendesk API does not expose it.
4. Plan and draft migration and breaking-change documentation for
   existing deployments; upgrade and rollback guidance already exists in
   `docs/operations.md`.

## Explicit non-goals

- API-token or password authentication.
- Committing OAuth credentials, access tokens, refresh tokens, or customer data.
- Treating MCP annotations as an authorization system.
- Embedding one Zendesk customer's brands, dashboards, groups, or workflows in
  the public core package.
