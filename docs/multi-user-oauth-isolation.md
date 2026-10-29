# Multi-user OAuth isolation design

This document designs — but does not implement — how one deployment could
serve more than one human without sharing OAuth credentials. It is grounded
in the current code and in the repository's deployment and contract
documents, and it cites each of them inline. Where a Zendesk API behavior
would decide a design choice but is not verified in this repository, the
document says so instead of asserting it.

This document changes no code and ships no behavior. The supported model
remains the single-tenant one defined in
[single-tenant-deployment.md](single-tenant-deployment.md) — one Zendesk
account per instance, one owner identity per host user — until an
alternative described here actually ships.

## Problem

Today one deployment means one Zendesk identity, and the following break
concretely when a second person shares it:

- **One token file cannot represent two Zendesk identities.** In
  `authorization_code` mode the connector reads a single token file
  (`~/.config/codex-zendesk/oauth.json` by default, moved by
  `ZENDESK_OAUTH_TOKEN_FILE`) and authenticates every API call with that
  one token ([auth.ts](../plugins/zendesk-connector/src/auth.ts)). The
  token belongs to whoever completed the OAuth authorization code flow; a
  second person cannot present their own identity through the same file.
  [single-tenant-deployment.md](single-tenant-deployment.md) refuses "one
  token file shared between host users" outright: such a copy is a
  credential outside the permission model, not a supported deployment.
- **There is no per-user revocation.** Logout clears the in-memory token,
  revokes it at Zendesk via `DELETE /oauth/tokens/current`, and removes the
  one token file ([auth.ts](../plugins/zendesk-connector/src/auth.ts)).
  Removing one person's access therefore removes everyone's; there is no
  way to end one user's access while the deployment continues for the
  others.
- **The allowlist cannot differ per user.** `ZENDESK_ALLOWED_TOOLS` is
  parsed once at server construction into one allowed set, and every
  handler re-checks that same set at call time
  ([policy.ts](../plugins/zendesk-connector/src/policy.ts),
  [server.ts](../plugins/zendesk-connector/src/server.ts)). A deployment
  that must deny the write tools to one person cannot allow them for
  another.
- **Audit `actorId` names the token's user, not the human caller.**
  `actorId` is populated from `GET /users/me.json` when `zendesk_status`
  succeeds ([server.ts](../plugins/zendesk-connector/src/server.ts),
  [tool-contracts.md](tool-contracts.md)). With one shared token, every
  event carries the same Zendesk user id regardless of who drove the MCP
  client, so the audit trail cannot attribute a call to a person.
- **The console takes one set of account identifiers.** It reads the same
  client file and one set of `ZENDESK_CONSOLE_*` values for one account
  ([single-tenant-deployment.md](single-tenant-deployment.md)); it has no
  notion of a caller, so everyone who can reach it sees the same views.

Sharing the client file is not a workaround either: the connector refuses
to start when the client file is readable by group or other — a check
skipped on Windows, where Node reports synthetic permission bits regardless
of the file's ACLs
([auth.ts](../plugins/zendesk-connector/src/auth.ts)), and
[SECURITY.md](../SECURITY.md) keeps OAuth client secrets in the environment
or in that owner-only file and never in the repository.

## Current state

What the code does today, split into what is already per-actor and what is
per-deployment.

**Per-deployment (one value for the whole instance):**

- The OAuth client and its secret. `getConfig` resolves the base URL, the
  client id and secret, the scope, the mode, and the token file from the
  environment and the owner-only client file, with environment variables
  winning key by key
  ([auth.ts](../plugins/zendesk-connector/src/auth.ts),
  [single-tenant-deployment.md](single-tenant-deployment.md)). The client
  secret comes from `ZENDESK_OAUTH_CLIENT_SECRET` or the client file and is
  sent with every token request.
- The token itself. In `authorization_code` mode a single access/refresh
  token pair is read from the token file, refreshed with
  `grant_type=refresh_token`, and written back owner-only via an atomic
  temporary-file rename
  ([auth.ts](../plugins/zendesk-connector/src/auth.ts)). `client_credentials`
  keeps tokens in memory only; `access_token` takes a fixed token from the
  environment and cannot renew it.
- The tool allowlist. `configuredTools()` reads `ZENDESK_ALLOWED_TOOLS`
  (and `ZENDESK_READ_ONLY`) once and returns one set; tools outside it are
  not registered, and each handler calls `assertToolAllowed` before acting
  ([policy.ts](../plugins/zendesk-connector/src/policy.ts)).
- The audit sink. Every handled call emits exactly one JSON line on stderr
  ([audit.ts](../plugins/zendesk-connector/src/audit.ts),
  [tool-contracts.md](tool-contracts.md)).
- The console's identifiers. One client file and one set of
  `ZENDESK_CONSOLE_*` values scope the console to one account
  ([single-tenant-deployment.md](single-tenant-deployment.md)).

**Per-actor (but "actor" today means the one Zendesk user behind the one
token):**

- The audit event carries `actorId`, the authenticated Zendesk user's id,
  established by a successful `zendesk_status` call and captured per call
  by `runTool`
  ([server.ts](../plugins/zendesk-connector/src/server.ts),
  [audit.ts](../plugins/zendesk-connector/src/audit.ts)). The event schema
  is fixed: `tool`, `operation`, `outcome`, `timestamp`, optional `status`,
  optional `actorId`.
- `zendesk_status` returns the authenticated user from the current-user
  endpoint, so the account — not the connector — already knows which
  Zendesk identity a token belongs to.
- What the account will allow at all is bounded by the token's OAuth scopes
  and by that user's role in Zendesk; the connector's allowlist only
  narrows further ([tool-contracts.md](tool-contracts.md)).

Two documented boundaries matter for any redesign: the connector binds no
listener and is never exposed over the network, and neither component has a
datastore ([single-tenant-deployment.md](single-tenant-deployment.md),
[SECURITY.md](../SECURITY.md)). The audit and allowlist contracts in
[tool-contracts.md](tool-contracts.md) are part of the versioned surface: a
redesign must keep one audit event per handled call and a meaningful
allowlist semantics.

## Requirements and invariants

Any design for multiple users must preserve all of the following:

- **No credential sharing between host users.** Each person's calls must
  authenticate with a token obtained through their own authorization. A
  token file or client file copied so two host users can read it stays
  refused, as it is today
  ([auth.ts](../plugins/zendesk-connector/src/auth.ts),
  [single-tenant-deployment.md](single-tenant-deployment.md)). API-token
  and password authentication remain unsupported
  ([SECURITY.md](../SECURITY.md)).
- **No cross-user data exposure.** One user's tool results, errors, and
  audit lines must never carry another user's credentials or token-file
  contents; the existing redaction of credential-shaped keys continues to
  apply to every payload
  ([audit.ts](../plugins/zendesk-connector/src/audit.ts),
  [tool-contracts.md](tool-contracts.md)).
- **One audit event per handled call, with a meaningful actor.** The event
  name and the fields `tool`, `operation`, `outcome`, `timestamp`,
  optional `status`, and `actorId` stay as documented; any new field is
  additive per the versioning policy
  ([audit.ts](../plugins/zendesk-connector/src/audit.ts),
  [tool-contracts.md](tool-contracts.md)). In a shared deployment the
  actor must identify the human caller, not merely the Zendesk identity of
  a token several people might otherwise share.
- **Revocation granularity per user.** Ending one person's access must not
  require revoking anyone else's credential, and a logout must affect only
  the logging-out user's session and stored tokens
  ([auth.ts](../plugins/zendesk-connector/src/auth.ts)).
- **Deployment controls stay enforceable.** An operator-set narrowing of
  the tool surface must still bound what every caller can invoke, with the
  documented startup validation and call-time re-check
  ([policy.ts](../plugins/zendesk-connector/src/policy.ts),
  [tool-contracts.md](tool-contracts.md)). OAuth scopes and the account's
  own role permissions remain the outer bound.
- **The single-tenant model stays unchanged until an alternative actually
  ships.** [single-tenant-deployment.md](single-tenant-deployment.md)
  remains normative; anything here that would relax the owner-only file
  model or the no-datastore, no-listener posture needs an explicit
  documented decision first, not silent drift.

## Options

Three genuinely distinct directions follow. Each is evaluated against the
OAuth flow, Zendesk's per-user tokens and scopes, operational complexity,
and this repository's no-datastore, owner-only-file posture.

### Option A: one local deployment per user (the status quo, extended and documented)

Every person runs their own connector instance under their own host user,
with their own client file, their own token file, their own
`ZENDESK_ALLOWED_TOOLS`, and their own stderr audit sink. No code changes;
the multi-user answer is documentation and per-user provisioning.

- **OAuth flow.** Each instance completes its own authorization code flow
  against the same account and the same (or a per-user) confidential OAuth
  client, and refreshes its own token
  ([auth.ts](../plugins/zendesk-connector/src/auth.ts)). PKCE applies only
  to public clients; this flow is confidential (client secret from the
  environment or the owner-only file) and uses no PKCE today. Whether
  Zendesk requires or supports PKCE for its OAuth clients needs
  verification. Concurrent `npm run oauth:setup` runs on one host could
  contend for the one-shot loopback callback port; whether that happens
  needs verification.
- **Zendesk tokens and scopes.** Naturally per-user: each token belongs to
  the user who authorized it, is bounded by the requested scopes and that
  user's role, and can be revoked individually — the revocation the
  connector already performs for its own token
  ([auth.ts](../plugins/zendesk-connector/src/auth.ts)).
- **Operational complexity.** Lowest code complexity (none), highest human
  complexity at scale: N host accounts, N client registrations, N upgrades,
  N audit sinks to collect. The allowlist is enforced per instance by
  configuration, so drift between instances is a real risk.
- **Posture fit.** Complete. Owner-only files keep meaning what they say,
  there is still no datastore and no listener, and isolation between users
  is enforced by the host's own permission model.

### Option B: a shared daemon holding per-user OAuth sessions

One long-running service accepts connections from multiple authenticated
humans, holds each user's OAuth token, and dispatches tool calls with the
per-user token and a per-user allowlist. The human's own identity (a
session established at sign-in) becomes the audit actor, alongside the
Zendesk user id fetched per user.

- **OAuth flow.** Each user completes an authorization code flow through
  the daemon; the daemon holds the client secret and refreshes each user's
  token. PKCE would apply if any part of the flow ran in a public client;
  in this design the daemon stays confidential, so PKCE is optional and
  its Zendesk support needs verification. Per-user scope requests become
  possible, but deciding what scopes each human may request is a new
  policy surface.
- **Zendesk tokens and scopes.** Best fit on paper: every call carries the
  calling human's own Zendesk token, so role permissions, scopes, and
  per-token revocation all work per user, and `actorId` finally matches the
  person. Whether Zendesk's token and revocation endpoints behave
  identically when driven concurrently for many users needs verification.
- **Operational complexity.** Highest. The service needs its own listener,
  its own human authentication, session expiry, and a multi-user token
  store — which conflicts with this repository's documented posture that
  the connector never binds a listener and neither component has a
  datastore
  ([single-tenant-deployment.md](single-tenant-deployment.md),
  [SECURITY.md](../SECURITY.md)). A directory of owner-only per-user files
  does not restore isolation, because the daemon process itself must read
  every user's token.
- **Posture fit.** Poor without an explicit, documented revision of the
  no-listener and no-datastore posture and of what "owner-only" means when
  one process holds everyone's credentials.

### Option C: a gateway in front of per-user connector instances

A thin gateway authenticates the human and routes each request to a
dedicated connector instance running today's single-tenant code with that
user's own client file and token file. Two variants differ in who holds
the credentials:

- **C1 — routing only.** The gateway holds no credentials; it maps an
  authenticated caller to that user's connector process and forwards the
  MCP traffic. Isolation stays where it is today: per host user, per
  owner-only files, per process. Audit stays in each connector's stderr,
  and the gateway can add the human identity to its own access log.
- **C2 — credential-holding.** The gateway holds every user's token and
  injects the right one per caller. This collapses into Option B's
  problems: one process holds all credentials, so the owner-only posture
  stops isolating users from each other.

Evaluating C1, the realistic variant:

- **OAuth flow.** Unchanged per user: each instance runs the same
  authorization code flow and refresh cycle it runs today
  ([auth.ts](../plugins/zendesk-connector/src/auth.ts)). The gateway never
  sees a token. PKCE considerations are identical to Option A.
- **Zendesk tokens and scopes.** Per-user, exactly as in Option A; the
  gateway adds no new Zendesk surface and therefore adds no new Zendesk
  API assumptions.
- **Operational complexity.** Moderate: process supervision for N
  connector instances, a caller-to-instance mapping, and a new networked
  component in front of something the deployment document currently says
  is never proxied
  ([single-tenant-deployment.md](single-tenant-deployment.md)). The
  connector code itself needs little or no change; the work is in the
  gateway and in operational documentation.
- **Posture fit.** Acceptable for C1: credentials stay per user in
  owner-only files, and each connector keeps its no-listener STDIO shape.
  The gateway's own authentication and its mapping store are the new
  things that must be designed and documented.

## Recommendation and phasing

**Recommendation: Option A now, Option C1 as the evolution path, Option B
deferred.** The reasoning:

- The repository's documented posture — owner-only files, no datastore, no
  listener, one audit event per call — is exactly what Option A already
  satisfies, and the roadmap places multi-user isolation before, not
  instead of, the single-tenant model. Documenting Option A as the
  intended multi-user answer closes the gap between what the deployment
  guide says and what a second person might naively try (sharing the token
  file), without new attack surface.
- Option C1 preserves every per-user invariant of Option A while removing
  its main cost (N independent setups with no shared entry point). It is
  the design to prototype once — and only once — real demand for a shared
  entry point exists, and it needs no new Zendesk API behavior.
- Option B is the only option that requires revising the no-listener and
  no-datastore posture and centralizing every user's credentials in one
  process. It should not start without that revision being an explicit,
  reviewed documentation change of its own.

Phased path (each phase is separate work; version numbers are illustrative
of ordering, not commitments):

1. **This change (design only).** This document. No code, no behavior
   change, no version bump, and — per the repository's changelog rule — no
   CHANGELOG entry, because ordinary changes add none.
2. **Next documentation release — landed.** Extend the operations and
   deployment docs with the Option A guidance: one deployment per host
   user, per-user OAuth client registration, per-user
   `ZENDESK_ALLOWED_TOOLS` examples, and how to collect and read per-user
   audit sinks. Still no connector code change. Landed in the
   [deployment guide](single-tenant-deployment.md#one-deployment-per-host-user)
   and the [operations guide](operations.md#several-instances-on-one-host).
3. **Later minor release, gated on a prototype.** Investigate Option C1:
   verify the Zendesk API questions listed above (PKCE support, concurrent
   per-user token behavior), confirm the gateway adds no credential
   exposure, and only then write implementation change requests.
4. **Deferred, gated on an explicit posture decision.** Option B, if ever,
   begins with a documented revision of SECURITY.md and
   single-tenant-deployment.md, not with code.

Until a phase that ships code lands, one deployment serves one Zendesk
account through one owner identity, exactly as
[single-tenant-deployment.md](single-tenant-deployment.md) defines today.
