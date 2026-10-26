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
  stdout and is never exposed over the network. The only socket it opens is
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
- The console needs the same egress to the Zendesk API host, because every
  dashboard request calls the account. It keeps no account data of its own.

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
export ZENDESK_ALLOWED_TOOLS="zendesk_status,zendesk_search_tickets,zendesk_get_ticket,\
zendesk_list_brands,zendesk_list_groups,zendesk_list_users,zendesk_list_organizations"
```

The allowlist is a deployment control. Combine it with the OAuth scopes and
the account's own role permissions rather than relying on any one layer.

## Operating the deployment

- **Backups.** The entire local state is the client file, the
  `authorization_code` token file, and the environment configuration. What to
  back up, how to restore the owner-only modes, and the recovery order are in
  the [operations guide](operations.md#backup-and-recovery). There is no
  datastore: a restore brings back credentials and identifiers, not ticket
  data, and backups of the account itself are the account's own concern.
- **Upgrades and rollbacks.** The container image is version-tagged with no
  `latest`, so an upgrade is an explicit tag change and a rollback is a pin
  to the previous tag. Record the running tag and digest before changing
  them. Procedures for the image, a local install, and the console are in
  the [operations guide](operations.md#upgrade) and its
  [rollback section](operations.md#rollback).
- **Exposed credentials.** If a credential may have been exposed, revoke it
  in Zendesk immediately and complete the authorization flow again, per
  [SECURITY.md](../SECURITY.md#credential-handling). A rollback or a redeploy
  does not invalidate a value that is still live in Zendesk.

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
