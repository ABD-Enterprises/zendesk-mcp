# Explore dashboards and reports: supported boundary

This note records the current, verified position of this connector on Zendesk
Explore dashboards and reports. It is a statement about this product's
supported surface, not a universal statement about Zendesk.

## Current position

- This connector ships no Explore tool and implements no Explore API
  integration. None of its current MCP tools read or write Explore
  dashboards, reports, or queries.
- The default OAuth scope
  (`plugins/zendesk-connector/src/auth.ts` `DEFAULT_SCOPE`) contains no
  Explore-specific scope; only the standard support scopes
  (`tickets`, `users`, `organizations`, `brands`, `groups`,
  `ticket_views`) are requested.
- We have not verified any Explore API endpoint for this product. External
  Zendesk API documentation was not reachable during the investigation that
  produced this note, so nothing here should be read as a claim that Zendesk
  does or does not expose an Explore API in general.
- As a result, users who need Explore dashboards or reports today should use
  the Zendesk Explore browser UI. That is the only Explore surface this
  product currently supports.

## What we would need before adding an API integration

Before an Explore tool could be designed or shipped, the following evidence
must be gathered and recorded (in this repository, with no customer data):

1. Official Zendesk documentation confirming the Explore API endpoints,
   request/response shapes, pagination, and rate limits.
2. The exact OAuth scope an integration must request, from the same official
   documentation.
3. A successful verification run against a disposable Zendesk sandbox
   account, exercising each candidate endpoint with the intended scope and
   confirming that access is granted (and what a scope or permission failure
   looks like).
4. A short write-up of the verified surface, following the module design
   conventions in `docs/resource-module-design.md`, including read/write
   behavior and the scope each operation requires.

Until all of the above exists, the browser-only boundary above stands and no
Explore scope, endpoint, or tool should be added to this connector.
