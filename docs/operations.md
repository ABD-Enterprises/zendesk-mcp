# Operations

This document describes how to run the Service Operations console behind a
reverse proxy, what to back up, and how to upgrade or roll back a deployment.

Two boundaries shape everything below:

- The MCP connector is a STDIO server. It speaks to its MCP client over
  stdin and stdout and serves no network port, so it is never fronted by a
  proxy and never exposed over the network. It does make outbound HTTPS
  requests to the Zendesk API, so a deployment needs egress to the account.
  The only listener it opens is the one-shot callback in
  `npm run oauth:setup`, which binds to loopback and closes when the browser
  returns the authorization code. Its health check is a command, not an
  endpoint.
- The console is the only long-running HTTP service in this repository. It
  binds to loopback, so a proxy on the same host is what makes it reachable.
  It calls the Zendesk API on request, so it needs the same egress.

Release and artifact procedures live in
[`docs/release-checklist.md`](release-checklist.md). This document covers the
operator steps around them.

## Deployment shape

One console instance serves one account configuration. The console takes its
identifiers from the environment and keeps no account data of its own, so a
second instance pointed at the same configuration reads the same views — it
adds no capacity, no isolation, and no second tenant.

Multi-tenant hosting is out of scope for this release. A deployment is
single-tenant by assumption: one Zendesk account, one client configuration,
one console instance, one OAuth client secret. The supported model and its
non-goals are written down in the
[single-tenant deployment guide](single-tenant-deployment.md); shared or
multi-account hosting waits for a change to that model.

## Several instances on one host

One host can carry several of the deployments the
[deployment guide](single-tenant-deployment.md#one-deployment-per-host-user)
defines — one single-tenant instance per person, each under its own host
user with its own client file, token file (in `authorization_code`
mode), and allowlist. That guide
states the provisioning rules; this section covers the audit stream and
the day-2 operation of the set. The design behind it, and what it does
not claim, live in the
[design document](multi-user-oauth-isolation.md). This is N single-tenant
instances composed, not multi-tenant hosting, which stays out of scope.

### Collecting per-user audit sinks

Every handled call emits exactly one audit event as a single JSON line
on that instance's stderr, plus the lifecycle lines, as the
[tool contracts](tool-contracts.md#audit-contract) define. The connector
writes no log file itself: the process that starts it — that person's
MCP client configuration or their process supervisor — owns the stderr
stream and is what captures it. Keep each person's stream in its own
file: the only identity a line carries is the Zendesk user id, so it is
the per-user file that attributes events to a person. Two shapes that
work:

- An MCP client that logs its child server's stderr to a per-user path.
- A supervisor that starts the server and appends stderr to a per-user
  file. Stdout must stay untouched — it carries the MCP protocol — so
  the redirection moves stderr only. The file carries Zendesk user ids,
  so keep it owner-only:

  ```sh
  umask 077
  mkdir -p ~/.local/state/codex-zendesk
  node /path/to/zendesk-mcp/plugins/zendesk-connector/dist/index.js \
    2>>~/.local/state/codex-zendesk/audit.ndjson
  ```

  (A globally installed `zendesk-mcp` command works in place of the
  `node` path; the source install has no such command.) An existing
  file with wider permissions is fixed by `chmod 600` on it and
  `chmod 700` on its directory.

Each file holds one JSON object per line, so read it with `jq`, for
example:

```sh
jq -r 'select(.event == "zendesk_tool_call") |
  [.timestamp, .actorId // "unknown", .tool, .operation, .outcome] | @tsv' \
  ~/.local/state/codex-zendesk/audit.ndjson
```

`actorId` — the authenticated Zendesk user's id — is held in memory and
established by a successful `zendesk_status` call, the first after each
start. That call's own event and any event before it carry no `actorId`
and read as `unknown` above, and so does every event after a restart:
run the tool once per instance after each start — including after
provisioning and after a restore — and only if the instance's
allowlist includes `zendesk_status`, if later events must carry it. Audit lines exclude
ticket contents and credentials; the full field list is in the
[tool contracts](tool-contracts.md#audit-contract).

### Day-2 operation of the set

Most day-2 procedures run once per person, as that person, because
each instance's configuration and owner-only files live under that
person's account. Host-level pieces — the reverse proxy and TLS section
below — are configured once for the host, not per person:

- **Health checks.** Run the connector's health-check command as each
  user; it validates that user's configuration and contacts nothing.
  A console, when used, is one instance per user and binds its own
  loopback port (`PORT` changes it). The console has no authentication,
  and loopback is host-wide, not per-user: any local user who can reach
  the port reads that dashboard, and the proxy section below is not
  access control against those local users — it only fronts the port it
  is configured for.
  The console also does not use the per-user token file: it reads its
  own client file and mints its own token from it, so the per-user
  token-file isolation above does not constrain what a console exposes.
  On a shared host, run a per-user console only where every local user
  is trusted to see every other user's dashboard, or do not run one.
- **Backups.** Back up each user's files separately, to that user's
  paths, and restore each user's owner-only modes as the
  [backup section](#permissions-after-a-restore) shows. Never merge
  archives, and never copy one user's client or token file to another
  user: the copied credential is the shared deployment the
  [deployment guide](single-tenant-deployment.md#non-goals) rules out.
- **Upgrades and rollbacks.** Each instance upgrades on its own only
  when each user runs their own install; a shared checkout or global
  install upgrades every instance pointing at it together. Either way,
  record the running version per instance, verify each account with
  that instance's `zendesk_status` after an upgrade, and roll back only
  the instances that need it. When an upgrade documents a configuration
  change, apply it to every user's instance deliberately — the same
  care applies to `ZENDESK_ALLOWED_TOOLS`, where drift between instances
  is the real risk of running the same server as several people.

## Reverse proxy and TLS

### What the proxy forwards

The console listens on `127.0.0.1:4177` (`PORT` changes the port) and speaks
plain HTTP to its proxy. The proxy terminates TLS; the console itself neither
serves nor validates certificates.

The traffic is ordinary request/response HTTP:

| Path | Response |
| --- | --- |
| `GET /api/status` | JSON liveness and configuration status; never calls Zendesk |
| `GET /api/overview` | JSON dashboard payload; calls Zendesk |
| Everything else | The single-page frontend from the built `dist/` directory |

The browser fetches `/api/overview` from the origin it loaded the page from.
Between the proxy and the console the hop is plain HTTP; there is no
WebSocket, server-sent event, or other streaming transport in the console, so
the proxy needs no upgrade or buffering configuration for it.

The console has no authentication of its own: the status endpoint, the
dashboard endpoint, and the frontend are all reachable without credentials.
The proxy is therefore the access control in front of the console, and a
proxy that only adds TLS exposes the console to everyone who can reach it.
Put an authentication layer (single sign-on, basic authentication, or an
address allowlist) in front of it, or keep the proxy on a private network.

Three further proxy details follow from how the console is written:

- By default the console answers only a request whose `Host` header names the
  loopback interface. A proxy forwards the name the browser asked for, not the
  loopback address, so a console behind a proxy needs that name in
  `ZENDESK_CONSOLE_ALLOWED_HOSTS`; without it every request is refused with
  `403`. The value is matched against the whole `Host` header, port included,
  so a proxy that forwards the port has to list it. The list is empty by
  default, and the console then answers only the loopback names.
- The console's file routes are rate limited per client address, and a request
  that passes the limit is answered with `429`. The limiter reads the socket
  address and not proxy headers, so behind a proxy every request to those
  routes counts against the proxy's address. `ZENDESK_CONSOLE_RATE_LIMIT` and
  `ZENDESK_CONSOLE_RATE_LIMIT_WINDOW_MS` adjust the limit. The two API
  routes are deliberately not behind the limiter — they are registered before
  the limiter is installed, and the test suite pins that scoping — so rate
  limiting them is the proxy's job.
- Every path that the console does not match is answered with the frontend
  entry point, so the proxy forwards all paths rather than a fixed list.

The console's own token asks for read scopes only. It reads two ticket views
and nothing else, so it asks for `ticket_views:read` — Zendesk documents that
scope as "view ticket views and the tickets they return" — and `tickets:read`
for the ticket fields the dashboard reads off the rows a view returns. The
scope comes from `ZENDESK_CONSOLE_OAUTH_SCOPE`, and then from the
`ZENDESK_OAUTH_SCOPE` the connector shares with it. The scope recorded in the
OAuth client file is the connector's scope and is not used here: it carries
write scopes, and the console writes nothing.

Both scopes are required. A scope that cannot read a view, or the ticket
fields on it, is a configuration error rather than a dashboard that quietly
shows every ticket as "Unclassified", and the console names what is missing.
The broad `read` scope covers both of them, because it covers every GET
endpoint, so a client that grants it needs nothing else: set the scope to
`read` and the console asks for that.

The scope has to be allowed on the Zendesk OAuth client as well. A client
that is not granted it answers the token request with `invalid_scope`, and
the console reports that in the dashboard.

Run the console in production mode behind a proxy: `npm run build` followed by
`npm start` in `apps/operations-console`. The development server starts a Vite
dev server on the same port, which is not meant to sit behind a shared proxy.

### nginx

```nginx
# /etc/nginx/conf.d/zendesk-console.conf
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name console.example.com;

    ssl_certificate     /etc/letsencrypt/live/console.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/console.example.com/privkey.pem;

    # The console has no authentication of its own, so the proxy is the only
    # access control in front of it.
    allow 203.0.113.10;
    deny all;

    location / {
        proxy_pass http://127.0.0.1:4177;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

`$host` drops the port, so the console sees `Host: console.example.com`.
Start the console with that name on its list:

```sh
ZENDESK_CONSOLE_ALLOWED_HOSTS=console.example.com npm start
```

### Caddy

```caddyfile
# /etc/caddy/Caddyfile
console.example.com {
    tls /etc/caddy/certs/console.example.com.crt \
        /etc/caddy/certs/console.example.com.key

    @blocked not remote_ip 203.0.113.10
    respond @blocked 403

    reverse_proxy 127.0.0.1:4177
}
```

Caddy forwards the original `Host` header, so the console sees
`Host: console.example.com` here too, and the same setting applies:

```sh
ZENDESK_CONSOLE_ALLOWED_HOSTS=console.example.com npm start
```

Caddy also obtains and renews a certificate on its own when the `tls`
directive is left out and the hostname resolves publicly; the example above
assumes an operator-supplied certificate.

### Health checks

The console's health endpoint is `GET /api/status`. It never calls Zendesk,
so it still answers when the account is unreachable:

```sh
curl -fsS http://127.0.0.1:4177/api/status
```

A configured console answers `200` with:

```json
{"ok":true,"configured":true,"missing":[],"missingLinks":[]}
```

The endpoint answers `200` even when the console is missing configuration, so
a check that looks only at the status code cannot see a misconfigured
console. The body is the signal: `configured` must be `true` and `missing`
must be empty. When configuration is missing, `missing` names the variables
that are absent.

`missingLinks` names the settings that only build a link into the account —
the open queue and the request-type report. They are not required: the
dashboard is read without them. The open-queue button then opens the
account's ticket list instead of the queue; the request-type report has no
view to open, and its button has nowhere to go: it shows the overview again
rather than a report. A name in `missingLinks` is therefore not a
misconfiguration, and a check that treats it as one will fail a console that
is working.

The endpoint is the health check for the console only. The connector's
health check is a command that validates the OAuth configuration and tool
policy and exits;
it prints one JSON line, contacts nothing, and has no URL to point a proxy
at:

```sh
node plugins/zendesk-connector/dist/index.js --healthcheck
```

A proxy that needs its own health path can forward one, but keep it restricted
to the monitoring address — the response body names the configuration
variables the console is missing.

### What the dashboard shows when it cannot be read

The dashboard page reads the account through `GET /api/overview`. There are
two failures, and they look different.

**The console cannot reach its own server** — the server is not running, or
the answer is not JSON. The page shows a red band above the dashboard,
carrying the console's own message, and the band is announced to assistive
technology. The sidebar shows the same reason. The dashboard below the band
is empty — zero tickets, no blockers, no ageing — because there is nothing
to measure. The band is what tells the operator that those zeros are the
console's answer and not the account's.

**The console reaches its server, and the account is the unreachable party**
— the account refuses the request, or the OAuth client file is not
owner-only. The server answers `503` with an `error` field, the page loads
normally, and the reason appears in the sidebar. Below 760 px the sidebar is
hidden, so the page carries no sign of that failure and the console's log is
where the reason is recorded.

Neither failure is answered with a zero-filled payload: the console answers
the account-side failure with `503` and a reason, and the console-side
failure never reaches the account at all. The page does render zeros in both
cases. The band, or the sidebar, is what says that they are the console's
answer.

## Backup and recovery

### What to back up

The connector's entire local state is two owner-only files plus the
environment configuration:

- **OAuth client file** — `~/.config/codex-zendesk/client.json` by default, or
  the path in `ZENDESK_OAUTH_CLIENT_FILE`. It carries the client secret.
- **OAuth token file** — `~/.config/codex-zendesk/oauth.json` by default, or
  the path in `ZENDESK_OAUTH_TOKEN_FILE`, or the `tokenFile` the client file
  names. It exists in authorization-code mode only.
- **Environment configuration** — the `ZENDESK_*` variables for the connector
  and the `ZENDESK_CONSOLE_*` variables for the console, in the process
  environment or in a secret manager. The console variables are listed in the
  [root README](../README.md#service-operations-console).

Environment variables win over the client file for every setting they name:
the subdomain, the OAuth mode, the client identifier and secret, the scope,
and the token path each come from the environment when it sets them. A
deployment that supplies all of them in the environment needs no file at all;
one that leaves any of them to the file has to back up the file as well.

### No datastore to back up

There is no datastore. Neither the connector nor the console keeps a database,
a local ticket store, or a cache on disk — tickets, comments, users, and
organizations live in the Zendesk account, and restoring a backup restores
credentials and identifiers, not ticket data. Backups of the Zendesk account
itself are the account's own concern.

### Permissions after a restore

Restore the files to the paths the deployment actually uses, then restore the
owner-only modes. The paths come from the environment, so resolve them rather
than assuming the default directory:

```sh
client_file="${ZENDESK_OAUTH_CLIENT_FILE:-$HOME/.config/codex-zendesk/client.json}"
token_file="${ZENDESK_OAUTH_TOKEN_FILE:-$HOME/.config/codex-zendesk/oauth.json}"

for file in "$client_file" "$token_file"; do
  [ -f "$file" ] || continue
  chmod 600 "$file"
  chmod 700 "$(dirname "$file")"
done
```

The loop skips the paths a deployment does not have: the token file exists
only in authorization-code mode, and a deployment that supplies every setting
in the environment has no file at all. When the client file names a
`tokenFile`, that path — not the default — is the token file the connector
reads, and it belongs in the loop as well.

A restore keeps the owner-only mode only if the archive carried it. The
connector refuses to start when the client file is readable by its group or
by others — except on Windows, where Node reports synthetic permission bits
regardless of the file's ACLs and the check is skipped — so a restore that
keeps the content but loses the mode fails closed at startup instead of
running with loose permissions. The token file
is not checked when it is read: the connector writes it with the owner-only
mode and replaces it atomically, so it repairs the mode on the next write,
but until then it keeps whatever the restore left behind. The console reads
the same client file and applies the same rule: it refuses to use a file
that is accessible to its group or by others — except on Windows, where Node
reports synthetic permission bits regardless of the file's ACLs and the check
is skipped — so a console on a client file with loose permissions answers its
dashboard request with `503`. `/api/overview` returns an `error` field of
"The Zendesk OAuth client file must be readable only by its owner (chmod 600)."
and the console logs the reason; the console process keeps running, and the
secret is never read into memory and never posted to the account. The page
itself still loads and shows "Zendesk unavailable" with that reason beside it
in the sidebar. The sidebar is hidden at 760 px and below, where the page
carries no sign of the failure and the console's log is where the reason is
recorded.

In a container deployment the client file also has to be readable by the
container's unprivileged `node` user. Align the owner with that user rather
than with the host account, and keep the mode owner-only.

A backup archive that carries these files carries the client secret and the
refresh token with them. Keep the archive as a secret, and treat a copy that
escapes as a leaked credential: revoke it as described under
[Leaked credential](release-checklist.md#leaked-credential) before restoring
anything.

### Recovery order

1. Restore the client file, and the token file in authorization-code mode, to
   their configured paths and set the owner-only permissions as above.
2. Restore the environment configuration: the `ZENDESK_*` variables for the
   connector and the `ZENDESK_CONSOLE_*` variables for the console.
3. Validate the connector configuration without contacting Zendesk:
   `node plugins/zendesk-connector/dist/index.js --healthcheck`, then
   `npm run doctor` from `plugins/zendesk-connector` — the health check never
   reads the token file, while the doctor reports a restored token file's
   state and permissions.
4. Start the console and read `GET /api/status`. The body must report
   `configured` as `true` with an empty `missing` list.
5. Confirm the account itself with the `zendesk_status` tool — the health
   check never reaches Zendesk, so a green health check is not proof that
   the credentials work.

## Upgrade

### Container image

Every released version publishes a version-tagged image and no `latest` tag,
so the upgrade is an explicit tag change in the configuration that starts the
container. The image reference pattern and the pull command are in the
[container image section](../README.md#container-image) of the root README.

1. Record the tag and the digest of the image that is running now; the
   [publish checklist](release-checklist.md#publish) shows the command that
   prints a digest. The previous tag and digest are what a rollback needs.
2. Change the tag in the run configuration and restart the container with
   the new image.
3. Verify the container and the account separately: the image health check
   reports that the configuration is present and well-formed, not that
   Zendesk is reachable, so confirm the account with the `zendesk_status`
   tool.

The image entrypoint is the STDIO MCP server, so the container is started by
its MCP client with stdin attached. Nothing about the image is a listening
service, and no proxy is involved in the upgrade.

### Local install

From a source checkout, update the working tree and rebuild:

```sh
cd plugins/zendesk-connector
npm ci
npm run build
```

To install a published version instead:

```sh
npm install -g @abd-enterprises/zendesk-mcp@<version>
```

The package installs the `zendesk-mcp` command, which the MCP client can
start in place of the `node` command that runs the built server.

The console is not part of the container image. It is a separate application,
so it is upgraded in its own directory:

```sh
cd apps/operations-console
npm install
npm run build
```

Restart the console process after the build.

### Pre-upgrade validation

The repository's canonical check is `npm run check` in
`plugins/zendesk-connector`, and it needs no Zendesk account. Run it in the
checkout before deploying a new version, so a broken build is caught before it
reaches a deployment. For the console, `npm run typecheck` and `npm test` in
`apps/operations-console` are the equivalent checks, and their tests run
against a local mock Zendesk server.

## Rollback

### Artifacts

The [rollback section](release-checklist.md#rollback) of
[`docs/release-checklist.md`](release-checklist.md) covers the published
artifacts: deprecating or unpublishing an npm version, moving a container tag
back to the previous digest by hand, revoking a leaked credential, and
reverting a release commit. A published version is never republished — the
release workflow refuses to overwrite an existing tag — so a rollback moves
the tag or pins the previous version rather than re-running the release.

### Operational order

1. Stop new traffic: remove the instance from the proxy's upstream
   rotation, or stop the console process.
2. Restore the previous artifact and configuration: pin the previous image
   tag or npm version, and put back the configuration that shipped with it.
   Configuration introduced by the upgrade — new environment variables,
   changed console identifiers — belongs to the rollback, not only the
   artifact.
3. Verify: run the connector health check, read `GET /api/status` and
   confirm `configured` is `true` with an empty `missing` list, then confirm
   the account with the `zendesk_status` tool.
4. Resume traffic: return the instance to the proxy's rotation and watch the
   logs for the failures that prompted the rollback.

When the rollback is caused by an exposed credential, revoke that credential
first. A rollback alone does not invalidate a value that is still live
everywhere the release reached.
