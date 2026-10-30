# Secrets and storage

This document describes how the connector receives and stores OAuth credentials
today, how a deployment can supply those credentials from a secret manager, and
what the repository deliberately leaves out. It documents existing behavior; it
does not describe a shipped secret-management feature.

## Where credentials live today

| Source | Contents | Owner-only check |
| --- | --- | --- |
| Environment variables | client id, secret, token, account URL | none |
| `client.json` | client id, secret, mode, scope, account URL | enforced on POSIX |
| `oauth.json` | access token, refresh token, expiry | enforced on write |

The two files live in `~/.config/codex-zendesk/` by default.
`ZENDESK_OAUTH_CLIENT_FILE` and `ZENDESK_OAUTH_TOKEN_FILE` move them. The
client file can also name the token file in a `tokenFile` field, and the
environment variable wins over that field.

### Environment variables

The variables that carry secret material are `ZENDESK_OAUTH_CLIENT_ID`,
`ZENDESK_OAUTH_CLIENT_SECRET`, and `ZENDESK_OAUTH_ACCESS_TOKEN`. The account
and OAuth variables carry no secret: `ZENDESK_SUBDOMAIN`, `ZENDESK_BASE_URL`,
`ZENDESK_OAUTH_MODE`, `ZENDESK_OAUTH_SCOPE`, `ZENDESK_OAUTH_CLIENT_FILE`, and
`ZENDESK_OAUTH_TOKEN_FILE`. The rest are operational rather than credential
settings: the callback port, the retry limits, the healthcheck flag, the tool
allowlist and read-only flag, and the shutdown timeout. The root
[configuration table](../README.md#configuration) lists the deployment
variables and their defaults.

Three rules govern how the connector reads them:

- Environment variables win over the client file, key by key. A value in the
  environment replaces the matching field in the file; the file still supplies
  everything the environment does not set.
- A value is trimmed, and an empty value counts as unset.
- A value that consists of exactly an unsubstituted `${...}` placeholder counts
  as unset. A templating step that fails therefore leaves the connector
  unconfigured instead of authenticating with a literal placeholder string.

Three settings read their value differently:

- `ZENDESK_OAUTH_CALLBACK_PORT` must be written as a run of decimal digits.
  Anything else — an empty value, a `${...}` placeholder, or a number written
  another way such as `0x10` — is an error rather than an unset value, and
  `npm run oauth:setup` stops with that error. `npm run doctor` reports the
  same error when it checks the setup callback; both read the value through
  one parser, so the two commands cannot disagree about the port.
- `ZENDESK_MAX_RETRIES` and `ZENDESK_MAX_RETRY_DELAY_MS` are read as JavaScript
  numbers, and whitespace around a number is ignored. `0x10` means 16 and
  `1e1` means 10 — inside the range of the longest wait, but outside the range
  of the count, which then uses its default. A value that is not an integer
  inside the allowed range falls back to the default, and a value of only
  whitespace counts as 0 rather than as unset.

### The client file

The client file defaults to `~/.config/codex-zendesk/client.json` and holds the
account URL, the OAuth mode, the scope, the client id, and the client secret.
It is the only file that carries the client secret in the default setup.

The connector treats it as sensitive:

- It must be a regular file.
- It must not be readable by group or other. Any group or other permission bit
  makes startup fail with a message that names the file and asks for
  `chmod 600` — except on Windows, where Node reports synthetic permission
  bits regardless of the file's ACLs, so the check is skipped there instead
  of failing every run.
- When `ZENDESK_OAUTH_CLIENT_FILE` is set and the file cannot be read, startup
  fails. When the variable is unset, an absent default file is not an error,
  and the connector falls back to the environment variables.

The one-time browser flow (`npm run oauth:setup`) reads the same configuration,
prompts for anything missing in a terminal (without one it prints what is
missing and exits 1), writes its result to the token file, and can save the
entered values to the client file.

### The token file

The token file defaults to `~/.config/codex-zendesk/oauth.json` and holds the
access token, the refresh token, the token type, the scope, and the expiry. It
is only used in `authorization_code` mode:

- `client_credentials` mode obtains an access token in memory, requests a new
  one after expiry or an authorization failure, and writes nothing to disk.
- `access_token` mode takes the token from `ZENDESK_OAUTH_ACCESS_TOKEN` and
  cannot renew it.
- `authorization_code` mode reads the file when it first needs an access token
  and rewrites it after every successful token request, including when Zendesk
  rotates the refresh token.

The connector writes the file with mode `0600`, creates the containing directory
with mode `0700` when it has to create it, and replaces the file through a
temporary file and an atomic rename. The rotated refresh token therefore never
replaces a complete file with a partially written one.

One asymmetry is worth knowing: the permission check applies to the client
file, not to the token file. The connector does not inspect the permissions of
a token file it reads. Keep the token file owner-only yourself. The doctor
preflight (`npm run doctor`) does inspect the token file's permissions and
fails the run when any group or other permission bit is set, turning this
silent gap into a reported one before the first request — except on Windows,
where Node reports synthetic permission bits regardless of the file's ACLs, so
the doctor skips the check there.

### Repository, logs, and the console

- `.env` and `.env.*` files are git-ignored; only `.env.example` is tracked.
- By default, tokens are stored outside the repository, in the user's
  configuration directory.
- No tool result and no console response contains credential material.
  `zendesk_status` reports the base URL, the OAuth mode, the scope, the
  refresh capability, the expiry, and the authenticated user — not the token
  file's path, which is filesystem information the agent would only repeat.
  The operator learns the path from `npm run doctor`, which names the file it
  checked, and the operations console never returns credentials to the
  browser.

The operations console reads the same client file, from
`ZENDESK_OAUTH_CLIENT_FILE` or from the default path, and uses the
`client_credentials` grant. It does not read `ZENDESK_OAUTH_CLIENT_ID` or
`ZENDESK_OAUTH_CLIENT_SECRET` from the environment, and it neither writes nor
reads a token file: its access token lives in the process memory for the
lifetime of the console. The console applies the same owner-only rule to the
client file it reads, and refuses to use a file that is accessible to group
or other (except on Windows, where Node reports synthetic permission bits
regardless of the file's ACLs and the check is skipped there): the console
keeps running, and its dashboard answers `503` with the reason.

## Supplying secrets from a secret manager

### What the connector supports today

There is no `_FILE`-style indirection for a single secret value. The two
`*_FILE` variables name whole JSON documents, not a file that holds one
credential: there is no `ZENDESK_OAUTH_CLIENT_SECRET_FILE`. A deployment
therefore has two supported shapes:

- Inject the values into the process environment at start.
- Write the client file the connector reads, and point
  `ZENDESK_OAUTH_CLIENT_FILE` at it.

`ZENDESK_OAUTH_TOKEN_FILE` adds a third, for `authorization_code` deployments
that need the token document in a specific place.

In the examples below, `example-vault` stands for the secret-manager CLI the
deployment uses and `example-secret-name` for the secret path inside it. Both
are placeholders.

### Pattern 1: inject environment variables at process start

```sh
#!/bin/sh
# Reads the OAuth client credentials from a secret manager and starts the server.
# Run it from the repository root, so the path to the built server resolves.
set -eu

example_vault_read() {
  example-vault read "secret/example-secret-name" --field "$1"
}

export ZENDESK_SUBDOMAIN="example-subdomain"
export ZENDESK_OAUTH_MODE="client_credentials"
export ZENDESK_OAUTH_CLIENT_ID="$(example_vault_read client_id)"
export ZENDESK_OAUTH_CLIENT_SECRET="$(example_vault_read client_secret)"

exec node plugins/zendesk-connector/dist/index.js
```

The trade-off is that the values end up in the process environment. Anything
that can read the environment of the process, including the same user through
the process filesystem and a container runtime through its inspection API, can
read them. Use one of the file patterns below when that matters.

### Pattern 2: materialize an owner-only client file

The wrapper writes the client file with restrictive permissions, hands its path
to the connector, and removes it when the server exits.

```sh
#!/bin/sh
# Materializes the OAuth client file for the lifetime of the server.
# Run it from the repository root, so the path to the built server resolves.
set -eu
umask 077

client_file="$(mktemp "${TMPDIR:-/tmp}/zendesk-client.XXXXXX")"
trap 'rm -f "$client_file"' EXIT HUP INT TERM

example_vault_read() {
  example-vault read "secret/example-secret-name" --field "$1"
}

client_id="$(example_vault_read client_id)"
client_secret="$(example_vault_read client_secret)"

# Build the document with a JSON-aware writer, so a value containing a quote
# or a backslash cannot break the JSON. The connector rejects a client file
# that does not hold a JSON object.
jq -n --arg client_id "$client_id" --arg client_secret "$client_secret" \
  '{subdomain: "example-subdomain", mode: "client_credentials",
    clientId: $client_id, clientSecret: $client_secret}' >"$client_file"
chmod 600 "$client_file"

export ZENDESK_OAUTH_CLIENT_FILE="$client_file"

# Do not use exec here: the trap has to run after the server exits.
node plugins/zendesk-connector/dist/index.js
```

Three details matter. The file is created under `umask 077` so it is never
readable by group or other, which is what the connector requires (the mode
check itself is skipped on Windows, where Node reports synthetic permission
bits). The server is started without `exec`, so the shell survives to run
the cleanup trap. And the document is written with a JSON-aware writer,
because the connector parses the file as JSON and fails to start on
malformed content.

### Pattern 3: mount files into the container

The published image reads the same two files from a mounted volume, as
described in the root [container section](../README.md#container-image):

```sh
docker run --rm -i \
  -e ZENDESK_SUBDOMAIN=example-subdomain \
  -e ZENDESK_OAUTH_MODE=authorization_code \
  -e ZENDESK_OAUTH_CLIENT_FILE=/secrets/client.json \
  -e ZENDESK_OAUTH_TOKEN_FILE=/secrets/oauth.json \
  -v "$HOME/.config/codex-zendesk:/secrets" \
  ghcr.io/abd-enterprises/zendesk-mcp:<version>
```

Four constraints apply:

- The image runs as the unprivileged `node` user, so the mounted client file
  must be readable by that user and the token file writable by it.
- The connector refuses a client file that group or other can read (a check
  skipped on Windows, where Node reports synthetic permission bits; this
  pattern runs the connector inside a Linux container, where it applies), so
  the mounted file must be owner-only and owned by the user the image runs
  as.
- Prefer the mounted file over `-e ZENDESK_OAUTH_CLIENT_SECRET=...`. A
  container environment variable is part of the container configuration and is
  readable through the runtime's inspection API; a mounted file is not.
- Never bake a secret into an image layer. The image entrypoint is the STDIO
  MCP server, and the healthcheck reports unhealthy until the configuration
  and tool policy are valid.

### Keeping a manager-seeded token file in sync

In `authorization_code` mode the connector rewrites the token file after every
successful token request, so the file on disk is the connector's copy and not
the manager's. A token file that a secret manager seeds is not written back to
the manager, so after the first rotation the manager holds a stale refresh
token while the connector holds the current one. A redeploy that re-seeds the
file can therefore break the refresh, and a stale refresh token cannot be
repaired in place: the operator has to run the browser flow again and replace
the file.

Two ways to avoid that: keep the rotated token file on a persistent volume that
the manager does not overwrite, or run in `client_credentials` mode, where
nothing is persisted. In `authorization_code` mode the directory that holds the
token file has to be writable by the process, because the connector writes the
rotated token next to the existing file. `client_credentials` mode writes
nothing to disk and needs no writable directory.

## Keeping token material encrypted at rest

The connector reads and writes plain JSON. The client file and the token file
are parsed with `JSON.parse`, and nothing inside the connector decrypts
anything. Encryption therefore belongs in the deployment around the connector,
and the options below protect the stored copy. They do not protect the copy the
running process reads.

### Option A: keep no token on disk

`client_credentials` mode is the simplest answer. The connector obtains an
access token in memory, requests a new one after expiry or an authorization
failure, and stores nothing. There is no token file to encrypt and no refresh
token to lose. The client secret still has to be stored somewhere, so the
keychain or volume question moves from the token file to the client file.

### Option B: keep the client secret in an OS keychain

The platform credential store — the macOS Keychain, Windows Credential
Manager, or a Linux keyring — can hold the client secret, and the wrapper
reads it at start exactly as in pattern 2. The connector has no keychain
integration; the keychain is the manager in front of it.

The trade-off is where the protection ends. The keychain protects the value at
rest on the host; once the wrapper reads it, the value is in the process
environment or in a materialized file, and the keychain's guarantees no longer
apply. A Linux service account usually has no unlocked keyring, so the
deployment needs a non-interactive unlock or a service-specific credential
store.

### Option C: encrypt the file and decrypt it at runtime

Keep the token document encrypted at rest with a tool of the deployment's
choice, and decrypt it into a RAM-backed directory only when the server starts.
The encrypted copy sits in the mounted volume next to the client file, and the
connector never reads it. A `--tmpfs` directory is private to the container, so
the decryption has to run inside the container, as a wrapper command:

```sh
docker run --rm -i \
  --tmpfs /run/zendesk:rw,noexec,nosuid,size=1m,mode=0700,uid=1000,gid=1000 \
  --entrypoint sh \
  -e ZENDESK_OAUTH_MODE=authorization_code \
  -e ZENDESK_OAUTH_CLIENT_FILE=/secrets/client.json \
  -e ZENDESK_OAUTH_TOKEN_FILE=/run/zendesk/oauth.json \
  -v "$HOME/.config/codex-zendesk:/secrets:ro" \
  ghcr.io/abd-enterprises/zendesk-mcp:<version> \
  -c 'set -e
      example-decrypt --input /secrets/oauth.json.enc --output /run/zendesk/oauth.json
      chmod 600 /run/zendesk/oauth.json
      exec node dist/index.js'
```

The script runs under `set -e`, so a failed decryption stops the container
instead of starting the server without a usable token file. Each command sits
on its own line: a newline terminates a command in `sh`, so a line that starts
with `&&` is a syntax error rather than a continuation.

`example-decrypt` stands for the deployment's decryption tool. The image ships
no such tool, so a deployment that decrypts inside the container needs a
derived image that adds one. The `uid` and `gid` must match the user the image
runs as; check them in the image rather than assuming them:

```sh
docker run --rm --entrypoint id ghcr.io/abd-enterprises/zendesk-mcp:<version>
```

The image's working directory is `/app`, so `node dist/index.js` starts the
server. The connector replaces a rotated refresh token by writing a new file
next to the old one, so the RAM directory has to stay writable for the lifetime
of the container.

To decrypt on the host instead, bind-mount a RAM disk that the host can write
and let the container see the same directory. The host path in the example is a
placeholder:

```sh
docker run --rm -i \
  -v /host-ramdisk:/run/zendesk \
  -e ZENDESK_OAUTH_MODE=authorization_code \
  -e ZENDESK_OAUTH_CLIENT_FILE=/secrets/client.json \
  -e ZENDESK_OAUTH_TOKEN_FILE=/run/zendesk/oauth.json \
  -v "$HOME/.config/codex-zendesk:/secrets:ro" \
  ghcr.io/abd-enterprises/zendesk-mcp:<version>
```

The host-side step decrypts into `/host-ramdisk` before the container starts,
and the container reads the same directory at `/run/zendesk`. The host RAM disk
has to be writable by the user the image runs as, for the same rotation
reason. A `--tmpfs` cannot serve this route: the container has no path to a
host directory that was never mounted.

The container still needs a plain file: the connector reads the decrypted
document with `JSON.parse` and cannot read an encrypted one. The decrypted copy
disappears with the RAM disk when the container stops, but it exists in plain
form for as long as the process runs.

### Option D: put the file on an encrypted volume

An encrypted host volume, an encrypted container volume, or a storage driver
that projects a secret into the workload all keep the stored copy encrypted
while the connector sees a plain file in the mounted path. The protection ends
at the same place as in option C: the file on the mounted volume is plain JSON
for the duration of the mount.

### What none of these options protect

- In `authorization_code` mode the plaintext token file exists for as long as
  the process runs. The `client_credentials` patterns above never write one.
- The process environment is readable by the same user and by root, and a
  container environment is readable through the runtime's inspection API.
- A backup or a snapshot of the host captures a decrypted file on a persistent
  volume, unless the backup runs against the encrypted volume itself. A
  container RAM disk is not part of a host backup, and an OS keychain keeps the
  secret out of the reach of an ordinary file backup.
- The connector's owner-only check covers the client file only. It does not
  police the permissions of a token file it reads, and it says nothing about
  how a file reached the disk.

## What this repository deliberately does not do

- No built-in key custody. The connector never creates, wraps, stores, or
  recovers an encryption key, and it has no secret-manager or key-management
  client.
- No encrypted token store. The token file is plain JSON; the connector sets
  owner-only permissions and replaces the file atomically, and nothing more.
- No `_FILE` indirection for a single value. Only the two whole-file path
  variables exist.
- No API-token or password authentication. OAuth only, by policy.
- No credentials in the tree. `.env` and `.env.*` files are ignored except
  `.env.example`, and the repository holds no live-account data.
- No credential output. No tool result and no console response contains a
  client secret, an access token, or a refresh token.

## Related documentation

- The root [configuration table](../README.md#configuration) lists the
  deployment variables and their defaults.
- [SECURITY.md](../SECURITY.md) states the credential-handling policy.
- [docs/product-roadmap.md](product-roadmap.md) lists secret-manager
  integration and encrypted persistent token storage as v0.6 roadmap work.
