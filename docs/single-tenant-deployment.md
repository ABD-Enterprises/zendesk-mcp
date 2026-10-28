# Single-tenant deployment

This document defines the supported deployment model: one Zendesk account per
instance, one owner identity per host user. It says what such a deployment
consists of, where each process runs, how configuration and credentials are
supplied, and which hosting shapes this repository does not claim. The
operator steps around the model — reverse proxy and TLS, backup and recovery,
upgrade and rollback — live in the [operations guide](operations.md); the
credential-handling policy lives in [SECURITY.md](../SECURITY.md).

## What single tenant means here

A deployment is single-tenant in two senses at once:

- **One Zendesk account per instance.** The connector authenticates to
  exactly one account through one OAuth client, and the console is scoped to
  the identifiers of that same account. Pointing a second instance at a
  second account is a second deployment with its own credentials, not a
  second tenant of the first.
- **One owner identity per host user.** The credentials live in owner-only
  files (or in the process environment) owned by a single host user. There
  is no per-tenant user mapping, no shared login, and no supported way for
  two host users to operate one deployment.

The components of a deployment are:

| Component | Role | Listener |
| --- | --- | --- |
| Connector (`plugins/zendesk-connector`) | STDIO server inside an MCP client | None |
| Console (`apps/operations-console`) | Optional back-office dashboard | Loopback only |

Two absences are part of the model:

- The connector has no listener. It speaks to its MCP client over stdin and
  stdout and is never exposed over the network. The only socket it binds is
  the one-shot loopback callback of `npm run oauth:setup`, which closes when
  the browser returns the authorization code.
- The console has no datastore. Neither component keeps a database, a local
  ticket store, or a cache on disk; tickets, comments, users, and
  organizations live in the Zendesk account.

## Topology

Each process has a fixed place in the deployment:

- The connector runs as a child process of the MCP client on the host, or as
  the entrypoint of the published container image with stdin attached. It
  serves no port and is never placed behind a proxy. Outbound HTTPS to the
  account's Zendesk API host is the only network requirement — for example
  `https://example-subdomain.zendesk.com`.
- The console runs on the same host as its reverse proxy and binds to
  `127.0.0.1:4177` (`PORT` changes the port). It speaks plain HTTP; the
  proxy terminates TLS and, because the console has no authentication of its
  own, the proxy is also the access control. The public hostname belongs to
  the deployment, for example `mcp.example.com`. nginx and Caddy examples
  are in the [operations guide](operations.md#reverse-proxy-and-tls).
- The console needs the same egress to the Zendesk API host, because each
  dashboard view is rendered from account data. It keeps no account data on
  disk.

### Health checks are commands

Neither component exposes an endpoint that proves the account works, so the
checks are commands run on the host:

```sh
# Connector: validates the OAuth configuration, contacts nothing, exits.
node plugins/zendesk-connector/dist/index.js --healthcheck

# Console: liveness and configuration status; never calls Zendesk.
curl -fsS http://127.0.0.1:4177/api/status
```

A green result from either command proves configuration shape, not account
access. Confirm the account itself with the `zendesk_status` tool. The exit
codes, response bodies, and failure modes are in the
[operations guide](operations.md#health-checks).

## Configuration and credentials

### Where configuration comes from

The connector reads its configuration from two sources: the owner-only client
file (`~/.config/codex-zendesk/client.json` by default, moved by
`ZENDESK_OAUTH_CLIENT_FILE`) and the process environment. Environment
variables win over the client file, key by key: a variable that is set
replaces the matching field, and the file supplies everything the environment
does not set. A deployment that sets every variable in the environment needs
no file at all; one that leaves any setting to the file has to protect the
file. The full variable table is in the
[root README](../README.md#configuration), and the storage patterns are in
[secrets-and-storage.md](secrets-and-storage.md).

### One OAuth client per deployment

Create one confidential OAuth client in the Zendesk account for the
deployment, as described in the
[root README](../README.md#configure-zendesk-oauth). A dedicated client per
deployment is what makes revocation precise: when a credential may be
exposed, revoke that client's values in Zendesk without disturbing any other
deployment. The default least-privilege scopes are:

```text
tickets:read tickets:write users:read organizations:read brands:read groups:read
```

Override them with `ZENDESK_OAUTH_SCOPE` only when a workflow needs a
different set. The OAuth mode is part of the deployment shape:
`authorization_code` keeps an owner-only token file on disk,
`client_credentials` keeps tokens in memory only, and `access_token` is for
testing and cannot renew a token.

### Owner-only permissions

The client file must not be readable by group or other; the connector
refuses to start when it is. The console reads the same file without
checking its mode, so the owner-only mode is the only protection there. The
token file (which exists in `authorization_code` mode only) is written
owner-only but not checked when it is read, so keep it owner-only yourself.
Restore the modes after any copy or restore, as the
[operations guide](operations.md#permissions-after-a-restore) shows.

### The console's own configuration

The console takes its account identifiers from the `ZENDESK_CONSOLE_*`
variables listed in the
[root README](../README.md#service-operations-console) and templated in
[`apps/operations-console/.env.example`](../apps/operations-console/.env.example).
It gets its credentials from the same client file as the connector and does
not read `ZENDESK_OAUTH_CLIENT_ID` or `ZENDESK_OAUTH_CLIENT_SECRET` from the
environment, so an all-environment connector deployment still needs a client
file once it runs the console. The identifiers are account-specific: keep
them in the environment or a secret manager, never in the tree.

### Least-privilege tool allowlist

OAuth scopes bound what the account will allow; `ZENDESK_ALLOWED_TOOLS`
bounds what the server will ask for, by naming a subset of the tools. A
read-only deployment allows the seven read tools:

```sh
export ZENDESK_ALLOWED_TOOLS="zendesk_status,zendesk_search_tickets,\
zendesk_get_ticket,zendesk_list_brands,zendesk_list_groups,\
zendesk_list_users,zendesk_list_organizations"
```

The allowlist is a deployment control. Combine it with the OAuth scopes and
the account's own role permissions rather than relying on any one layer.

## Operating the deployment

Day-2 procedures live in the [operations guide](operations.md). This
section states what each one means for this deployment model — one account
per instance, one owner identity per host user — and does not repeat the
general steps.

### Reverse proxy and TLS

The connector never sits behind a proxy: it binds no long-running listener,
and the only socket it opens is the one-shot loopback OAuth callback, so it
needs no TLS of its own. The console is the deployment's only exposed
endpoint; it binds loopback and speaks plain HTTP, so TLS termination at
the proxy is what puts it behind HTTPS, and the proxy is also its access
control. One hostname serves the one account behind it, so the proxy needs
no tenant routing and no per-tenant certificates. The configurations,
forwarded paths, and rate-limit behavior are in the
[operations guide](operations.md#reverse-proxy-and-tls).

### Backup and recovery

The deployment's entire local state is the client file, the token file
(`authorization_code` mode only), and the environment configuration; there
is no datastore. A restore therefore brings back credentials and
identifiers, not ticket data — tickets, comments, users, and organizations
live in the Zendesk account, and backups of the account itself are the
account's own concern. An archive of these files carries the client secret
and the refresh token with them, so keep it as a secret. What to back up,
the owner-only modes to restore, and the recovery order are in the
[operations guide](operations.md#backup-and-recovery).

### Upgrade

The container image is version-tagged with no `latest`, so an upgrade is an
explicit tag change and nothing moves on its own; record the running tag
and digest before changing them, because the previous tag and digest are
what a rollback needs. One instance serves one account, so an upgrade
changes only the software — the client file, the token file, and the
environment configuration carry over unchanged unless the new version
documents a configuration change. The console is a separate application and
upgrades in its own directory against the same account configuration.
Commands for the image, a local install, and the console are in the
[operations guide](operations.md#upgrade).

### Rollback

A rollback pins the previous image tag (or npm version) using the tag and
digest recorded before the upgrade, and restores any configuration the
upgrade changed along with the artifact. It restores the software, not a
different deployment: the same account, the same client, and the same
owner-only files remain. A rollback or a redeploy does not invalidate a
credential that is still live in Zendesk — if a credential may have been
exposed, revoke it in Zendesk immediately and complete the authorization
flow again, per [SECURITY.md](../SECURITY.md#credential-handling). The
operational order is in the [operations guide](operations.md#rollback).

## One deployment per host user

Several people can use this connector on one host without sharing a
deployment, by composing the model this document defines: one
single-tenant deployment per person, each under that person's own host
user. This is Option A of the
[design document](multi-user-oauth-isolation.md), which stays the source
of truth for the reasoning and for what this composition does not cover.
It composes the single-tenant model; it does not extend it, and nothing
multi-tenant is implied or supported.

Each person's deployment is provisioned separately:

- **Separate host accounts.** Each person signs in as their own host
  user, so every default path under `~/.config/codex-zendesk/` already
  resolves to that person's own files, and the host's permission model
  isolates each deployment's owner-only files and its stdio server
  process from the others. That isolation covers files and processes,
  not loopback sockets: see the
  [console caveat](operations.md#several-instances-on-one-host) in the
  operations guide. One instance
  running as one host user on behalf of several people is the shared
  deployment this document rules out, not a smaller version of this one.
- **Separate token files.** In `authorization_code` mode each instance
  reads its own token file — `~/.config/codex-zendesk/oauth.json` under
  the owning user's home by default, moved by that instance's own
  `ZENDESK_OAUTH_TOKEN_FILE`. One token file per person is what makes
  each token belong to the user who completed that instance's
  authorization flow. (Modes without a token file — `client_credentials`
  and `access_token` — are covered under
  [One OAuth client per deployment](#one-oauth-client-per-deployment)
  above.)
- **Separate allowlists.** Each instance parses its own
  `ZENDESK_ALLOWED_TOOLS` at startup and re-checks it on every call; the
  value set for one instance says nothing about another.

### Per-user OAuth client registration

Each person registers their own confidential OAuth client in the account,
as described in the
[root README](../README.md#configure-zendesk-oauth), and keeps the client
id and secret in their own client file (`~/.config/codex-zendesk/client.json`
under their own home, moved by `ZENDESK_OAUTH_CLIENT_FILE`) or in their
own environment. One registration per person, and no shared client file:
the connector refuses to start when the client file is readable by group
or other. The console reads the same file without checking its mode, so
the owner-only mode is the only protection there — a file two host users
can read is refused by the connector rather than shared, and kept out of
the console's reach only by its mode.

Sharing one client registration widens the blast radius of a leak, and
sharing one token file defeats the reason to run per-user deployments.
With one shared token file, ending one person's access means revoking
the one token everyone's calls depend on, and letting it stand means
leaving that person able to act. Per-user token files already bound
that: logging one person out revokes only their own token, so with
per-user clients as well — revoking or rotating one person's client in
Zendesk, or rotating its secret — nothing anyone else runs changes.
What stays shared under one registration is the client secret itself:
it is read by every instance that uses it, so a leak of that secret
reaches every token minted from it. One registration per person keeps
that blast radius to one person's deployments.

### Per-user allowlist examples

Different people on one host commonly carry different allowlists. A
reader gets the seven read tools and nothing that writes:

```sh
# Reader: reads only.
export ZENDESK_ALLOWED_TOOLS="zendesk_status,zendesk_search_tickets,\
zendesk_get_ticket,zendesk_list_brands,zendesk_list_groups,\
zendesk_list_users,zendesk_list_organizations"
```

A triage role adds the comment tool but still cannot create or edit
tickets. The allowlist filters tool names, not arguments, so this
grants more than internal notes:

```sh
# Triager: reads plus comments.
export ZENDESK_ALLOWED_TOOLS="zendesk_status,zendesk_search_tickets,\
zendesk_get_ticket,zendesk_list_brands,zendesk_list_groups,\
zendesk_list_users,zendesk_list_organizations,\
zendesk_add_ticket_comment"
```

`zendesk_add_ticket_comment` posts an internal note or a public reply —
the caller chooses with the tool's `public` input, and an allowlist
that includes the tool cannot force internal notes. Granting it to a
role therefore grants customer-visible replies too; a role that must
never reply publicly should not carry it.

Each value lives in that person's MCP client configuration or
environment, so when the tool set or a person's duties change, review
each instance's allowlist rather than assuming one edit covers the host.
The allowlist stays a narrowing control: it bounds what each server will
offer, while the OAuth scopes and the account's own role permissions
still bound what Zendesk will allow. How to collect each instance's audit
output is in the
[operations guide](operations.md#several-instances-on-one-host).

## Non-goals

The repository makes no claim on the shapes below. A deployment that needs
one is outside the supported model:

- **Multi-tenant hosting.** One instance serves one account. The roadmap
  places any multi-account work after a supported single-tenant model — the
  model this document defines — and the
  [operations guide](operations.md#deployment-shape) keeps multi-tenant
  hosting out of scope for this release.
- **One token file shared between host users.** The client file is refused
  when group or other can read it, and the token file is owner-only by
  design. A copy shared between host users is a credential outside the
  permission model, not a supported way to run one deployment for two users.
- **Pooling one console across accounts.** The console takes one set of
  account identifiers from the environment and keeps no account data of its
  own. A second instance pointed at the same configuration reads the same
  views and adds no capacity, no isolation, and no second tenant.
- **Horizontal scaling.** The connector is a per-client STDIO process and
  the console is a single loopback-bound instance. The repository makes no
  horizontal-scaling claim for either one; capacity against the Zendesk
  API's own limits — including the connector's automatic `429` retries — is
  the deployment's own concern.
