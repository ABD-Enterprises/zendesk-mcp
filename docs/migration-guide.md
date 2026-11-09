# Migration guide

This guide describes how to move an existing deployment of this connector from
one release to another: how to read a target release's breaking changes, how
to map them onto the tool clients and the configuration a deployment runs, how
to stage and validate the change, and how to verify it afterwards.

It is a general procedure. It does not restate what any particular release
changed: the [changelog](../CHANGELOG.md) and the root [README](../README.md)
carry the release-specific facts and remain the source of truth for the
release in question. Where this guide and those two disagree, they are
wrong here.

## What this guide does and does not promise

- **No automatic migration.** A release does not convert a deployment's
  configuration, allowlists, or artifacts, or automatically grant new OAuth
  scopes. The connector can refresh OAuth tokens during normal operation; that
  is not a migration. There is no migration script, no on-start conversion,
  and no compatibility shim for a changed contract. Every migration step
  below is an operator action, and a deployment upgraded without them keeps
  the configuration it had.
- **No Zendesk data to convert.** The connector keeps no ticket datastore:
  tickets, comments, users, and organizations live in the Zendesk account, and
  an upgrade does not touch them. The deployment does have local OAuth client
  and, in authorization-code mode, token files; an upgrade does not convert
  them. They remain credentials and deployment state, covered by the existing
  [backup guidance](operations.md#what-to-back-up).
- **The contract is fixed by the versioning policy, not by this guide.** Which
  changes count as breaking, and which version bump carries them, is defined
  in [tool-contracts.md](tool-contracts.md#versioning-policy). This guide only
  says what to do with the changes that policy has already classified.
- **The mechanics live elsewhere.** Installing an artifact, restoring one, and
  resuming traffic are in the [operations guide](operations.md#upgrade) and
  [rollback](operations.md#rollback). This guide says when to use them and what
  to check around them.

## Step 1 — Read the target release's breaking changes

The release-specific facts are in three places:

- [CHANGELOG.md](../CHANGELOG.md), in the section for the target version.
  Breaking entries are marked `**Breaking:**`.
- The root [README](../README.md), which carries the upgrade note for a
  release and the compatibility notes for configuration values whose meaning
  changed.
- [tool-contracts.md](tool-contracts.md), which documents the contract the
  release implements — tool names, inputs, outputs, errors, audit events, the
  allowlist, and the versioning policy that says which of those changes are
  breaking.

The versioning rule in one line, with the detail left to the contract
reference: while the package is `0.x`, a breaking change ships in a minor bump
and is called out in both the changelog and the root README; after `1.0`, a
breaking change ships in a major bump.

A release that changes a documented contract without that callout is a defect
in the release, not a migration for the operator to guess. Report it; do not
infer the change from the code or from a failed call.

## Step 2 — Map each breaking change to what it affects

Work entry by entry, not release by release: two breaking changes in the same
release usually land in different places, and one of them can affect a
deployment the other does not.

| Change kind | What to check | Where the contract lives |
| --- | --- | --- |
| Tool surface — a tool added, renamed, or removed | Every `ZENDESK_ALLOWED_TOOLS` value, the MCP client configuration, and any client-side allowlist or prompt that names the tool | [Allowlist contract](tool-contracts.md#allowlist-contract) |
| Input contract — a required input added, a default changed, a value now refused | The callers that build the call: client prompts, scripts, agents | [Tools](tool-contracts.md#tools) |
| Output contract — a field renamed, retyped, removed, or now only sometimes present | Whatever parses the result | [Result envelope](tool-contracts.md#result-envelope) |
| Error behavior — a call that used to succeed now fails, or fails differently | The callers' error handling, their retry expectations, and any alerting on failure counts | [Error contract](tool-contracts.md#error-contract) |
| Configuration semantics — an environment variable's parsing or meaning changes, a new variable becomes required | The deployment's environment and secret manager | [Configuration table](../README.md#configuration) |
| OAuth scope — the effective requested scope set changes | The scope configuration, the token the deployment holds, and the Zendesk OAuth client's allowed scopes | [One OAuth client per deployment](single-tenant-deployment.md#one-oauth-client-per-deployment) |

Record the result per instance. A deployment is often several instances — one
per host user — and the entries do not apply to all of them equally:

| Breaking entry | Instance | Affected client or setting | Action | Verification |
| --- | --- | --- | --- | --- |
| | | | | |

An entry that affects no instance is still worth recording: it is the answer
to "did we check that one?".

## Step 3 — Coordinate the settings several parts share

Three settings are shared between the server, its clients, and Zendesk itself.
They are changed deliberately and in a fixed order, not as a side effect of
the software upgrade.

### Tool allowlists

Every instance parses its own `ZENDESK_ALLOWED_TOOLS` at startup and re-checks
it on each call. A value naming a tool the new release does not have — a
removed or renamed one — is rejected at startup, and the offending names are
reported; a duplicate is rejected the same way. An allowlist that names a tool
the target release dropped therefore stops the server rather than quietly
serving a smaller surface.

Check each instance's allowlist against the target release's tool table before
deploying, and decide per role whether a newly added tool is wanted. The
allowlist is a narrowing control: a deployment that sets one serves a new
tool only when the allowlist admits it, so leaving it out keeps the old
surface, which is a valid migration outcome.

`ZENDESK_READ_ONLY` interacts with the allowlist: read-only mode together
with an allowlist that names a write tool is refused at startup, naming the
conflicting tools.

### OAuth scopes

When a release needs additional scopes, first check the deployment's effective
requested scope: `ZENDESK_OAUTH_SCOPE` overrides the saved client-file value,
which overrides the release default. A token may not carry the added scope, and
the affected tools can fail with `403` until a suitable token is issued. The
account role must also permit the operation; adding a scope alone does not
grant account permissions. Coordinate the change in this order:

1. Allow the new scope on the Zendesk OAuth client in Admin Center when that
   client has allowed scopes configured. Without it, the token request is
   refused with `400 invalid_scope`.
2. Set the effective requested scope to the target value, then arrange for a
   token with that grant. In `authorization_code` mode, re-run
   `npm run oauth:setup` so the larger grant replaces the stored token; in
   `client_credentials` mode, the next token request uses the configured
   scope; in `access_token` mode, obtain and supply a replacement token with
   the required grant. Follow the target release's README note if it gives
   more specific instructions.
3. Deploy the new release.

Do not enable calls to the affected tools until the configuration and token
are ready. If rollout order requires deploying the release first, keep those
tools out of use until step 2 is complete.

### Configuration values

A variable whose parsing changed keeps its old meaning only if its value
still says what it used to: a whitespace-only value that used to parse as
zero now counts as unset. Where a release calls out such a change, set the
variable explicitly to the value the deployment wants rather than leaving the
old literal in place. The root README's compatibility note on
`ZENDESK_MAX_RETRIES` and `ZENDESK_MAX_RETRY_DELAY_MS` is an example of this
kind of entry.

Apply configuration changes with the artifact, not after it: the new release
must not start against a configuration it cannot parse. A rollback restores
the configuration that shipped with the previous artifact, so keep the old
value recoverable until the migration is verified.

## Step 4 — Stage the migration

1. Record the current state of every instance: the running version, and for a
   container deployment the image tag and digest. A rollback needs them.
2. Validate the release in a checkout before it reaches a deployment:
    `npm ci`, `npm run check`, `npm run e2e:mock`, and `npm pack --dry-run` in
    `plugins/zendesk-connector`; for the console, `npm ci`,
    `npm run typecheck`, `npm run build`, `npm test`, and
    `npm audit --omit=dev --audit-level=moderate` in
    `apps/operations-console`. None of these need a Zendesk account
   ([pre-upgrade validation](operations.md#pre-upgrade-validation)).
3. Exercise the release against a disposable sandbox account. The read-only
   end-to-end harness (`npm run e2e`) drives the built server over stdio
   against `ZENDESK_BASE_URL` and `ZENDESK_OAUTH_ACCESS_TOKEN` and never calls
   a write tool; see the
   [connector README](../plugins/zendesk-connector/README.md#end-to-end-tests).
   This is the step that catches a contract change the mock suite does not
   model.
4. Migrate one instance at a time. A shared checkout or a global install moves
   every instance pointing at it together, so decide whether the deployment
   can take that as one unit
   ([several instances on one host](operations.md#several-instances-on-one-host)).
5. Keep the console's upgrade separate: it is a different application, with
   its own directory and its own build
   ([upgrade](operations.md#upgrade)).

## Step 5 — Verify the migrated instance

Verify with reads first, and verify the calls the breaking change touched.

### Configuration and account

- `node plugins/zendesk-connector/dist/index.js --healthcheck` — validates the
  configuration shape and the tool policy. It contacts nothing, so a green
  result proves nothing about the account.
- `npm run doctor -- --tools` from `plugins/zendesk-connector` — the same
  validation plus the stored token file's state and permissions. It prints the
  configured/requested scope and enabled tools; when a token is stored, it
  also prints the scope the account granted. This is an offline check, not a
  Zendesk connectivity check.
- `zendesk_status` — the first real check: it checks access to the
  authenticated-user endpoint and names the authenticated user. Its reported
  OAuth scope is the configured/requested scope, not a scope read back from
  the token. It also establishes `actorId` for the audit events that follow,
  so make it early on every instance.

### Behavior

- Call each read tool the breaking change touched, and read the field the
  change is about. A consumer of a changed output field has to be re-pointed
  at the new shape; the server cannot make an old consumer correct.
- Check the refusal paths the change introduced: a call the new release
  rejects must fail with the documented error. A refusal that happens before
  the request — a schema or policy failure — never reaches Zendesk. The
  error contract's unexpected-payload failure is the exception: a caller
  receiving it cannot tell whether a write reached Zendesk
  ([error contract](tool-contracts.md#error-contract)).
- Read the instance's audit stream afterwards and compare it with the target
  release's documented audit contract. A shape change that was not called out
  in the release notes is a signal rather than a new format
  ([audit contract](tool-contracts.md#audit-contract)).

### Writes

- Do not verify a write against a production account. Use a disposable sandbox
  account for that, and leave the write tools out of the instance until the
  read checks are green. The project's own position — sandbox first,
  production later — is in the root README's
  [project status](../README.md#project-status).

### Console

- `GET /api/status` must report `configured` as `true` with an empty `missing`
  list. A check that only reads the status code cannot see a misconfigured
  console ([health checks](operations.md#health-checks)).

## Step 6 — Roll back the instances that failed

The procedure is in the [operations guide](operations.md#rollback): stop new
traffic, restore the previous artifact and the configuration that shipped with
it, verify, resume traffic. Two points belong to a migration specifically:

- Roll back at the granularity the deployment supports. Independently installed
  instances that passed verification can stay on the new release while failed
  ones return to the previous artifact. A shared checkout or global install
  must be treated as one unit because every instance pointing to it moves
  together.
- A rollback restores the software, not the credentials. If the attempt
  exposed a credential — a token written to a log, a client file copied
  somewhere shared — revoke it in Zendesk. Rolling back leaves it valid
  everywhere else it was used
  ([credential handling](../SECURITY.md#credential-handling)).

## After the migration

- Update the recorded running version for every instance, so the next
  migration starts from the current state rather than from memory.
- Keep the worksheet from step 2 with the deployment's own records. It is the
  map of which client consumes which tool, and the next upgrade starts from
  it.
