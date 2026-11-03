# Resource module designs

This document designs — but does not implement — the MCP tool modules for
the Zendesk resource families named in the v0.7 roadmap
([product-roadmap.md](product-roadmap.md)): ticket views, triggers, macros,
automations, SLA policies, and Guide categories, sections, and articles. It
follows the same contract as [multi-user-oauth-isolation.md](multi-user-oauth-isolation.md):
it is grounded in the current code, it cites that code inline, and where a
Zendesk API behavior would decide a design choice but is not verified in this
repository, it says so instead of asserting it.

This document changes no code, changes no OAuth defaults, and ships no
behavior. In particular, it does **not** enable, request, or claim any new
OAuth scope. Scope strings below are split into three explicit classes:

- **Known** — strings that appear in this repository today and can be read
  directly in the cited source.
- **Candidates** — hypotheses based on the `<resource>:read` /
  `<resource>:write` pattern visible in this repository, but **not verified**
  against current Zendesk endpoint documentation or sandbox behavior. The
  naming pattern is not evidence that a scope exists. Confirm every candidate
  before any code references it; a candidate that turns out to be wrong is a
  design error, not a runtime surprise.
- **Unknown** — no scope name is proposed because this repository provides no
  reliable basis for one. Do not infer a scope from the resource name; verify
  it from current endpoint documentation and a sandbox token first.

## Module boundaries and shared patterns

Each resource family becomes one module with one tool prefix, following the
patterns the existing fourteen tools already establish:

- **One tool policy source.** `ALL_TOOLS` in
  [policy.ts](../plugins/zendesk-connector/src/policy.ts) remains the single
  source of truth for the tool surface. A new module adds its tools there,
  classifies its write tools in `WRITE_TOOLS`, and regenerates the tool
  tables with `node scripts/generate-tool-tables.mjs --write` so the
  repository README, [tool-contracts.md](tool-contracts.md), the plugin
  README, and `.env.example` stay consistent.
- **One server registration.** Tools are registered in `server.ts`. If a
  module grows past a handful of tools, its handlers can move to a dedicated
  file (for example `src/modules/triggers.ts`) that `server.ts` imports;
  the policy lists and generated tables do not change shape either way.
- **Naming.** Read tools are `zendesk_list_<resource>` (collections) and
  `zendesk_get_<resource>` (single records). Write tools are
  `zendesk_create_<resource>`, `zendesk_update_<resource>`, and
  `zendesk_delete_<resource>` only where a delete is ever justified — the
  connector ships no delete tool today and that default should not change
  casually (see [Rollout dependencies](#rollout-dependencies)).
- **Result envelope.** Collection tools return the shared envelope defined in
  [tool-contracts.md](tool-contracts.md): `count`, `page`, `perPage`,
  `nextPageAvailable`, plus the records under a tool-specific key. Single-record
  tools return the record object. Both go through the client's envelope
  validation (`collection` / `object` options in
  [client.ts](../plugins/zendesk-connector/src/client.ts)) so a malformed
  payload fails with a fixed error instead of an undefined shape.
- **Pagination.** Collection tools take `page` (default 1) and `perPage`
  (default 25, max 100), sent to Zendesk as `page` and `per_page`, and derive
  `nextPageAvailable` from the API's `next_page` link. Where an endpoint
  reports no total, `count` falls back to the page length, as
  `zendesk_list_view_tickets` already does.
- **Policy and audit.** Read tools are served in read-only mode automatically;
  write tools are excluded by `ZENDESK_READ_ONLY=1` and can be filtered with
  `ZENDESK_ALLOWED_TOOLS`. Every tool call — read or write — emits a
  `zendesk_tool_call` audit event with `operation: "read" | "write"` and the
  outcome ([audit.ts](../plugins/zendesk-connector/src/audit.ts)). New
  modules must not weaken either mechanism.
- **Versioning.** Adding tools is a minor-version change; changing a shipped
  tool's contract is a breaking change and belongs in `CHANGELOG.md` under
  `Unreleased` with the root README called out, per the versioning policy.

## Known OAuth scope facts (this repository only)

The default scope the connector requests is defined once in
[auth.ts](../plugins/zendesk-connector/src/auth.ts) and is currently:

```
tickets:read tickets:write users:read organizations:read brands:read groups:read ticket_views:read
```

From that, two facts are known today:

- `ticket_views:read` is required by the two view tools that shipped in
  `0.7.0` (`zendesk_list_views`, `zendesk_list_view_tickets`), and the
  default scope was extended to include it ([CHANGELOG.md](../CHANGELOG.md)).
- Every known scope string follows the `<resource>:<verb>` pattern with
  `read` and `write` verbs.

Every scope column below labels its status as **known**, **candidate**, or
**unknown**; only known scopes are facts established by this repository.

## Views module

Views already have a landed read surface; this section extends the design,
not the code.

**Endpoint family:** the current tools use `GET /api/v2/views.json` and
`GET /api/v2/views/{id}/tickets.json`. Verify any additional endpoint against
current Zendesk documentation before implementation.

- Candidate read: `GET /api/v2/views/{id}.json` (single view definition).
- Candidate read: `GET /api/v2/views/count.json` and the per-view count
  family for ticket tallies without fetching ticket bodies.
- Candidate write (deferred): `POST /api/v2/views.json`,
  `PUT /api/v2/views/{id}.json`, `DELETE /api/v2/views/{id}.json`,
  `PUT /api/v2/views/{id}/tickets.json` (bulk ticket update through a view —
  side-effect heavy, likely out of scope permanently).

**Initial read surface:** shipped (`zendesk_list_views`,
`zendesk_list_view_tickets`). A natural addition is `zendesk_get_view`
returning one view's definition, since editing flows need the raw conditions.

**Proposed write surface (deferred):** `zendesk_create_view`,
`zendesk_update_view`. View conditions encode raw ticket-field predicates;
malformed condition JSON is the likeliest failure mode, so the tool must
validate shape client-side and pass Zendesk's validation errors through
unchanged.

**Pagination/envelope:** `views.json` returns a paginated collection with
`count` and `next_page`; `views/{id}/tickets.json` documents no total, so the
page-length fallback already implemented stays.

**Scope:** `ticket_views:read` — **known**. `ticket_views:write` — **candidate**
for the deferred write tools.

## Triggers module

Business rules that fire on ticket events. Access may depend on account role
and plan; verify permissions with current Zendesk documentation and sandbox
behavior before choosing an initial audience.

**Endpoint family** (verify paths and verbs against current documentation):

- Read: `GET /api/v2/triggers.json`, `GET /api/v2/triggers/{id}.json`.
- Candidate write (deferred): `POST /api/v2/triggers.json`,
  `PUT /api/v2/triggers/{id}.json`, and any reorder endpoint (trigger
  evaluation order is significant; reordering is a global side effect that
  deserves its own deliberation, not a bundled parameter).

**Initial read surface:** `zendesk_list_triggers`,
`zendesk_get_trigger`. Example envelope (invented values):

```json
{
  "count": 2,
  "page": 1,
  "perPage": 25,
  "nextPageAvailable": false,
  "triggers": [
    { "id": 4101, "title": "Notify example on-call group", "active": true }
  ]
}
```

**Proposed write surface (deferred):** `zendesk_create_trigger`,
`zendesk_update_trigger`. Trigger `actions` reference custom field ids and
group ids; the tool documents but cannot validate those references, so the
design accepts Zendesk-side validation failure as the normal error path.

**Pagination/envelope:** expect a paginated collection, but verify the
presence and meaning of `count`, `next_page`, and the `triggers` array key
against the current endpoint documentation and sandbox response. At
implementation time the client's `collection: "triggers"` option can reject
a response missing that key; it does not establish Zendesk's response
contract.

**Scope:** `triggers:read` / `triggers:write` — **candidates**, unverified.

## Macros module

Canned responses agents insert into tickets. Lower privilege than triggers —
agents use them constantly — but a maliciously edited macro can send wrong
content to customers under an agent's name.

**Endpoint family** (verify against current documentation):

- Read: `GET /api/v2/macros.json`, `GET /api/v2/macros/{id}.json`.
- Candidate actions (deferred): macro apply endpoints under tickets
  (`PUT /api/v2/tickets/{id}.json` with macro placeholders, or a dedicated
  apply endpoint if one exists — verify which) so a macro can be previewed
  before use.
- Candidate write (deferred): `POST /api/v2/macros.json`,
  `PUT /api/v2/macros/{id}.json`, `DELETE /api/v2/macros/{id}.json`.

**Initial read surface:** `zendesk_list_macros`, `zendesk_get_macro`.
Macro bodies contain placeholders (for example `{{ticket.requester.name}}`);
read tools pass bodies through verbatim and never interpolate them — that
distinction belongs in the tool description so an LLM caller does not
"magically" resolve placeholders locally.

**Proposed write surface (deferred):** `zendesk_create_macro`,
`zendesk_update_macro`. Macro bodies are customer-visible text; the audit
implications section below applies in full. Deletes are irreversible and
should stay unimplemented unless a concrete need appears.

**Pagination/envelope:** verify pagination parameters, response array key,
and total behavior against current endpoint documentation and a sandbox
response before choosing a shared collection envelope.

**Scope:** `macros:read` / `macros:write` — **candidates**, unverified.

## Automations module

Time-based business rules ("run once, X hours after..."). Structurally
similar to triggers but evaluated on a schedule; an automation that fires
unexpectedly reopens or closes real tickets in bulk.

**Endpoint family** (verify against current documentation):

- Read: `GET /api/v2/automations.json`, `GET /api/v2/automations/{id}.json`.
- Candidate write (deferred): `POST /api/v2/automations.json`,
  `PUT /api/v2/automations/{id}.json`.

**Initial read surface:** `zendesk_list_automations`,
`zendesk_get_automation`. The `conditions`/`actions` shapes mirror triggers;
both are passed through as account-owned payloads, matching the rule in
[tool-contracts.md](tool-contracts.md) that passed-through fields are not
part of the connector contract.

**Proposed write surface (deferred):** `zendesk_create_automation`,
`zendesk_update_automation`, with `active` treated as an explicit boolean
input — silently deactivating a live automation is exactly the kind of
destructive-adjacent semantics the write deferral exists to scrutinize.

**Pagination/envelope:** verify pagination parameters, response array key,
and total behavior against current endpoint documentation and a sandbox
response before choosing a shared collection envelope.

**Scope:** `automations:read` / `automations:write` — **candidates**,
unverified.

## SLA policies module

Service-level targets per ticket criteria. The least-visible module here:
SLA policies shape breach calculations across the whole account.

**Endpoint family:** verify the SLA policies API paths, verbs, response shape,
and permissions against current documentation before implementation.

- Read: `GET /api/v2/slas/policies.json`, `GET /api/v2/slas/policies/{id}.json`.
- Candidate write (deferred): `POST /api/v2/slas/policies.json`,
  `PUT /api/v2/slas/policies/{id}.json`.

**Initial read surface:** `zendesk_list_sla_policies`,
`zendesk_get_sla_policy`. Policy targets (first-reply time, next-reply time,
resolution time, business-hours flag) are the fields the tools should
surface most clearly in their descriptions, since they are what operators
actually audit.

**Proposed write surface (deferred):** `zendesk_create_sla_policy`,
`zendesk_update_sla_policy`. A wrong target quietly changes breach behavior
for every matching ticket; this is the strongest argument in the module set
for keeping writes behind verified sandbox testing.

**Pagination/envelope:** expect a standard collection; the array key and
`count` presence are unverified — the client's envelope validation is what
turns a wrong assumption here into a clear error instead of a silent shape
change.

**Scope:** the scope naming for SLA policies is **unknown, not a verified
candidate**. It does not follow from anything in this repository. Confirm the
actual scope string from the current Zendesk endpoint documentation and a
sandbox token before this module is even scheduled.

## Guide module (categories, sections, articles)

Guide content lives under the Help Center API, which is a different surface
from the Support API the connector calls today.

**Endpoint family** (verify against current documentation):

- Read: `GET /api/v2/help_center/categories.json`,
  `GET /api/v2/help_center/sections.json`,
  `GET /api/v2/help_center/articles.json`, and the single-record variants
  under those paths.
- Candidate write (deferred): `POST`/`PUT` under the same families. Help
  Center write behavior (draft versus published states, translation handling)
  needs dedicated verification; article bodies are customer-visible content.

**Module boundary decision:** Guide is one module with three resource shapes,
not three modules. Categories, sections, and articles share the Help Center
base path, locale handling, and translation semantics; splitting them would
duplicate all of that. The tool prefix stays `zendesk_help_center_...` (for
example `zendesk_list_help_center_articles`) rather than `zendesk_guide_...`,
because "Guide" is the product name while Help Center is what the API paths
say — but that naming choice itself is a design proposal, not a shipped
contract.

**Initial read surface:** `zendesk_list_help_center_categories`,
`zendesk_list_help_center_sections`, `zendesk_list_help_center_articles`,
`zendesk_get_help_center_article`. Locale filtering (for example
`/api/v2/help_center/{locale}/articles.json`) is a candidate design point to
verify; the list tools likely need an optional `locale` input rather than
silently returning the account default.

**Proposed write surface (deferred):** create/update for articles first
(`zendesk_create_help_center_article`, `zendesk_update_help_center_article`),
then sections and categories only if a concrete need appears. Draft-versus-
published semantics and translation propagation must be understood in a
sandbox before any write tool ships.

**Pagination/envelope:** Help Center list endpoints are expected to be
paginated collections, but page-size limits and the total's reliability are
unverified; treat `count` presence as per-endpoint knowledge recorded during
sandbox verification, not assumed.

**Scope:** Guide/Help Center scope strings are **unknown, not verified
candidates**. Do not infer them from the Support API's `<resource>:<verb>`
pattern; confirm from current endpoint documentation and a sandbox token
before scheduling.

## Cross-cutting implications

### Policy and audit

- Every new tool, read or write, is auditable on day one through the existing
  `zendesk_tool_call` event. Write tools should include the affected resource
  id in the audit detail where the current audit schema allows it, matching
  how ticket writes are attributable today.
- Macro bodies, article bodies, and trigger/automation actions can carry
  customer-visible text. The redaction rules that already apply to ticket
  content in logs and errors ([SECURITY.md](../SECURITY.md)) extend to these
  payloads without exception.
- Read tools join the allowlist automatically and compose with
  `ZENDESK_READ_ONLY=1`; a deployment that wants, say, macros but not triggers
  configures `ZENDESK_ALLOWED_TOOLS`. No new policy mechanism is needed for
  any module in this document.

### Mock-test strategy

All testing is hermetic, following the existing suite
([server.test.ts](../plugins/zendesk-connector/src/server.test.ts),
[list-pagination.test.ts](../plugins/zendesk-connector/src/list-pagination.test.ts),
[tool-contract.test.ts](../plugins/zendesk-connector/src/tool-contract.test.ts)):

- **Unit, mock HTTP:** each tool's handler is tested against a mocked fetch
  with invented fixtures asserting the shared envelope, page/perPage echo,
  `nextPageAvailable` derivation, and the page-length `count` fallback where
  the endpoint omits a total.
- **Envelope validation:** each new endpoint's `collection`/`object`
  validation is tested with a malformed body to pin the fixed
  "unexpected response payload" error.
- **Policy interplay:** each module's tools are tested under
  `ZENDESK_READ_ONLY=1` and a restrictive `ZENDESK_ALLOWED_TOOLS`, including
  the read-only/write conflict error.
- **Audit:** each tool emits exactly one `zendesk_tool_call` event with the
  right `operation`, and write events carry the affected resource id.
- **Failure paths:** 401, 429 with retry, and scope-denied responses follow
  the patterns the v0.5 work established for the ticket tools.
- **End-to-end:** the hermetic `npm run e2e:mock` harness gains one scenario
  per module; no live account is needed for any of the above.

### Sandbox verification (before writes, after reads)

Each module's read tools run once against a disposable Zendesk sandbox to
confirm: the endpoint paths and response envelopes assumed above, the actual
required scope string, and the behavior when the token lacks the scope. The
results get recorded in this document (or the module's PR), turning
candidates into facts one module at a time. The repository's standing rule
applies throughout: live tools run only when the owner asks, read-only first,
sandbox or test account only for anything that writes.

## Rollout dependencies

1. **Documentation verification (blocking, per module).** Confirm endpoint
   paths, verbs, envelopes, and scope strings against current Zendesk
   endpoint documentation; update the candidate markings in this document.
2. **Read tools first (one module per PR).** Policy entry, generated tool
   tables, changelog entry under `Unreleased`, hermetic tests, and
   `npm run check` green before merge. Views' remaining read gap
   (`zendesk_get_view`) can ride with any module's PR or its own.
3. **Sandbox read validation (blocking for writes).** Record observed
   envelopes and scope behavior; only then schedule that module's write
   tools.
4. **Write tools (deferred, per module).** Shipped only after the endpoint's
   write behavior (validation errors, idempotency), permission requirements
   (admin-only resources may be unusable with a standard agent token —
   verify what a sandbox admin token can do), and destructive or
   irreversible semantics (deletes, reordering, deactivation, bulk updates)
   are verified in the sandbox. Any irreversible operation is a separate
   design decision, not a default.
5. **OAuth scope changes (owner decision, separate change).** Extending
   `DEFAULT_SCOPE` in [auth.ts](../plugins/zendesk-connector/src/auth.ts) or
   an account's allowed scopes in Admin Center happens deliberately, per
   scope, after that scope is verified — mirroring how `ticket_views:read`
   shipped. This document does not change any scope, and no implementation
   PR may smuggle a scope change in with tools.

## Open questions to resolve during verification

- The actual scope strings for triggers, macros, and automations (candidates
  here), and the scope naming for SLA policies and Help Center (unknown).
- Whether SLA policy list endpoints report a reliable total.
- Whether Help Center list endpoints accept `per_page` and `page` uniformly
  and how locale filtering composes with pagination.
- Whether any of these write endpoints are admin-only in a way that makes a
  standard agent-granted token useless, and whether that argues for separate
  read and write scope configuration.
- Whether trigger reordering is exposed as an endpoint, and if so whether it
  can ever be offered safely as an MCP tool.
- Whether Guide writes require handling draft/published state and
  translations explicitly in the tool inputs, or whether Zendesk-side
  defaults are safe to inherit.
