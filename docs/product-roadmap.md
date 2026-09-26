# Zendesk MCP Product Roadmap

## Current position

The repository is an OAuth-only local MCP prototype for Zendesk Support. It
currently provides ticket search, ticket reads, ticket creation, ticket
updates, ticket comments, and a local service-operations console.

It is not yet an organization-ready shared service. The largest gaps are
multi-user OAuth isolation, authorization policy, auditability, deployment,
release engineering, and broader Zendesk resource coverage.

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
- Add health and readiness endpoints for service deployments.
- Add graceful shutdown and structured JSON logging.
- Document secret-manager integration and encrypted persistent token storage.
- Add reverse-proxy/TLS, backup, recovery, upgrade, and rollback guidance.
- Define a supported single-tenant deployment model before attempting
  multi-tenant hosting.

### v0.7: Zendesk resource coverage

- Add brands, groups, users, organizations, ticket fields, and forms.
- Add views, triggers, macros, automations, and SLA resources.
- Add Guide categories, sections, and articles.
- Investigate and add supported Explore dashboard/report operations where the
  Zendesk API exposes them; otherwise document the browser-only boundary.
- Keep each module's OAuth scopes and read/write behavior explicit.

### v1.0: Supported product

- Stabilize MCP tool contracts and versioning.
- Publish security, privacy, data-retention, and incident-response policies.
- Add SBOM generation, dependency scanning, and signed release artifacts.
- Complete end-to-end tests against a disposable Zendesk sandbox.
- Publish migration and upgrade documentation.
- Complete an independent security review before recommending production use.

## Buildable today

The following work can be completed in the current repository without needing
new Zendesk credentials or customer-side configuration:

1. Establish neutral public-product branding and remove customer-specific
   references from the public package documentation.
2. Add CI workflows for typecheck, tests, package dry runs, and dependency
   auditing.
3. Add a changelog, versioning policy, issue templates, and a release checklist.
4. Add a policy module with configurable read/write tool allowlists.
5. Add structured audit events and secret/content redaction tests.
6. Harden OAuth configuration validation and refresh-token concurrency handling.
7. Add Docker packaging, a health check, graceful shutdown, and deployment
   documentation.
8. Add generic test fixtures and contract tests for the existing Zendesk tools.
9. Design the resource-module interfaces for Guide, ticket configuration, and
   organizational resources without enabling untested production writes.

## Explicit non-goals

- API-token or password authentication.
- Committing OAuth credentials, access tokens, refresh tokens, or customer data.
- Treating MCP annotations as an authorization system.
- Embedding one Zendesk customer's brands, dashboards, groups, or workflows in
  the public core package.
