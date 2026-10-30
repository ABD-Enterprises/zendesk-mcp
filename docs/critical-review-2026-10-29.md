# Critical Review — `zendesk-mcp`

**Date:** 2026-10-29
**Reviewed revision:** `main` @ `386f270` (v0.6.1) — the fixes of this round have since advanced `main` past it. `386f270` is on `main`, so every code location below can be read at it. The two commits this review also names, `1111f74` and `c46ef87`, are PR #71's own commits and are **not** on `main` — the pull request was squash-merged as `ecb704e` — so a reader who wants them fetches `refs/pull/71/head`.
**Scope:** `plugins/zendesk-connector/` (MCP server), `apps/operations-console/` (local web console), `.github/workflows/`, plugin manifests, `docs/`
**Baseline:** `npm ci && npm run check` — typecheck clean, **171 tests, 0 failures**
**Status:** Review artifact. Committed and tracked since PR #72; the disposition index in section 8 is kept in step with the tree.

**Total: 44 findings — 4 High, 20 Medium, 19 Low, 1 Info.**
Sections 3–5 below are this agent's findings. **Section 6** adds the findings from the parallel agent's review that I independently re-verified against source (**S0, M12, M13, M14**). **Section 7** adds the two findings from my review of PR #71 (**P1, P2**). **Section 8** is the complete 44-row index with disposition and the filed issue number for each.

> **Reading guide.** Every finding was re-verified line-by-line against source by the reviewer before being recorded here; each is marked **Confirmed** (read in source and the defect is real) or **Suspected** (needs runtime confirmation). Subagent output was used as a lead list, never as evidence.

---

## 0. Quick reference — paste-ready

Copy this block on its own; the full evidence for every finding is in sections 3–7.

**44 findings — 4 High, 20 Medium, 19 Low, 1 Info.** 36 fixed and merged, 1 closed by decision, **7 open**, each with a filed issue.

**Done.** Every item this review put first is merged; §8 says which pull request each finding landed in. **Still open:** M1 (#42), M2 (#43), M6 (#50), M7 (#51), M8 (#52), M11 (#55) and M13 (#48) — six deferred refactors, and the tag and publish that are the owner's to make.

| ID | Sev | Area | Finding | Location | Issue | Disposition |
|---|---|---|---|---|---|---|
| S0 | **High** | Security | Runtime token-exchange failure hands the raw body to the agent | `auth.ts:421-437` | #31 | **Merged** — PR #71 |
| S1 | **High** | Security | Token-exchange failure prints the raw access token to stderr | `oauth-setup.ts:597-601` | #30 | **Merged** — PR #29 |
| S2 | Med | Security | Token-file write follows a pre-planted symlink | `auth.ts:593-605` | #32 | **Merged** — PR #73 |
| S3 | Med | Security | Console has no Host/origin validation (DNS rebinding) | `server.mjs:350` | #33 | **Merged** — PR #75 |
| S4 | Med | Security | `redact()` matches key names only; strings never scrubbed | `audit.ts:127-138` | #34 | **Merged** — PR #73 |
| S5 | Low | Security | Tool-call audit path skips `redact()` | `audit.ts:81` | #35 | **Merged** — PR #73 |
| S6 | Low | Security | Console mints a `read write` scope for a read-only app | `server.mjs:170` | #36 | **Merged** — PR #75 |
| S7 | Low | Security | Console performs no base-URL validation | `server.mjs:162` | #37 | **Merged** — PR #75 |
| S8 | Low | Security | Raw error messages returned to the browser | `server.mjs:295-300` | #38 | **Merged** — PR #75 |
| S9 | Low | Security | `/api/*` not rate-limited *(deliberate)* | `server.mjs:253,262` | #39 | **Merged** — PR #78 |
| S10 | Low | Security | No PKCE *(acknowledged in the docs)* | `oauth-setup.ts:463-475` | — | Closed by decision |
| S11 | Low | Security | `zendesk_status` discloses the token-file path | `auth.ts:370-378` | #41 | **Merged** — PR #73 |
| S12 | Info | Security | CI falls back to self-hosted runners if the guard var is deleted | `ci.yml` | #40 | **Merged** — PR #76 |
| M1 | Med | Maint | The tool list is written out by hand in twelve files | `docs/`, `README.md` | #42 | Open — deferred refactor |
| M2 | Med | Maint | `safeJson` triplicated; `errorMessage` + mode predicates duplicated | `auth.ts:631` etc. | #43 | Open — deferred refactor |
| M3 | Med | Maint | `destructiveHint: false` hardcoded for all three write tools | `server.ts:467-474` | #44 | **Merged** — PR #74 |
| M4 | Med | Maint | `tags: []` silently clears every tag on a ticket | `server.ts:199,501` | #45 | **Merged** — PR #74 |
| M5 | Med | Maint | `npm run e2e:mock` never runs in CI | `ci.yml:43` | #46 | **Merged** — PR #76 |
| M6 | Low | Maint | Unsound generic cast on unvalidated JSON | `client.ts:110` | #50 | Open — deferred refactor |
| M7 | Low | Maint | Global `fetch` bypasses the injectable fetcher | `oauth-setup.ts:578` | #51 | Open — deferred refactor |
| M8 | Low | Maint | 4 env-access styles, 4 validation policies | `auth.ts`, `policy.ts`, `client.ts` | #52 | Open — deferred refactor |
| M9 | Low | Maint | `.env.example` documents 8 of ~16 `ZENDESK_*` vars | `.env.example` | #53 | **Merged** — PR #78 |
| M10 | Low | Maint | Console duplicates domain constants server↔frontend | `server.mjs:46` | #54 | **Merged** — PR #79 |
| M11 | Low | Maint | `server.ts` concentrates 12 tool definitions in one function | `server.ts` | #55 | Open — deferred refactor |
| M12 | Med | Maint | The three write tools are never invoked by any test | `server.test.ts:147` | #47 | **Merged** — PR #71 |
| M13 | Med | Maint | Version drift: `0.6.1` vs only `v0.6.0` tagged | `package.json` | #48 | Open — owner action (tag and publish) |
| M14 | Low | Maint | Audit gate hides a live moderate advisory | `@hono/node-server@2.1.1` | #49 | **Merged** — PR #76 |
| U1 | **High** | Usability | `commentUsers` is always `undefined` | `server.ts:136` vs `:141` | #56 | **Merged** — PR #74 |
| U2 | Med | Usability | Search mislabels non-ticket results as tickets | `server.ts:94-100` | #57 | **Merged** — PR #74 |
| U3 | Med | Usability | Truncated comments have no continuation path | `server.ts:136,142` | #58 | **Merged** — PR #74 |
| U4 | Med | Usability | Console `load()` has no `catch` → silent empty dashboard | `App.tsx:210-217` | #59 | **Merged** — PR #80 |
| U5 | Med | Usability | Search description omits pagination, shape, id handoff | `server.ts:61-74` | #60 | **Merged** — PR #74 |
| U6 | Med | Usability | Write-tool descriptions are 5 words; params undescribed | `server.ts:152,184,214` | #61 | **Merged** — PR #74 |
| U7 | Med | Usability | No `--help`; unknown flags start the server and hang | `index.ts:14-47` | #62 | **Merged** — PR #77 |
| U8 | Med | Usability | Doctor can't detect scope/expiry; never prints enabled tools | `doctor.ts:71-114` | #63 | **Merged** — PR #77 |
| U9 | Med | Usability | Console requires 7 config IDs, needs 5 for data | `server.mjs:48-56` | #64 | **Merged** — PR #79 |
| U10 | Med | Usability | Two shipped surfaces disagree on which comments return | `server.ts:110` vs `tool-contracts.md:104` | #65 | **Merged** — PR #74 |
| U11 | Low | Usability | No `logout` / `healthcheck` npm script | `package.json` | #66 | **Merged** — PR #78 |
| U12 | Low | Usability | Manifest uses a relative path for the entrypoint | `.mcp.json:6` | #67 | **Merged** — PR #78 (documentation) |
| U13 | Low | Usability | Console workstream statuses are hard-coded literals | `App.tsx:96-104` | #68 | **Merged** — PR #80 |
| U14 | Low | Usability | Two headline metrics measured inconsistently | `server.mjs:280-281` | #69 | **Merged** — PR #79 |
| U15 | Low | Usability | `Math.max(0, ...array)` risks a stack overflow | `server.mjs:283` | #70 | **Merged** — PR #79 |
| **P1** | **High** | Security | Retained `error` value gated by shape, not vocabulary | `auth.ts:661-666` @ `1111f74` | #31 | **Merged** — PR #71 |
| **P2** | Med | Security | Field-name rule missed adjacent credential shapes | `auth.ts:680-684` @ `1111f74` | #31 | **Merged** — PR #71 |

---

## 1. Summary

The engineering quality is high: CI is mature (OIDC publish, Node 20/22/24 matrix, a hermetic mock e2e harness), the OAuth `state` is 24 bytes of `randomBytes` and is validated, the callback server binds loopback-only, `redact()` exists and is applied on three of four log paths, and `doctor` produces genuinely actionable messages.

Three classes of real defect were found.

1. **One credential leak was live on `main`.** A failed OAuth token exchange prints the raw response body — which can contain a live access token — to stderr. The fix is **PR #29** (`ed5b30d`), and it is **merged**.
2. **The agent-facing tool contract had behavioural defects.** Two of the twelve tools returned data that did not match their own description: `zendesk_get_ticket` reads a `users` side-load it never requests (so comment authors never resolve), and `zendesk_search_tickets` labels non-ticket search results as tickets and hands back broken ticket URLs.
3. **Write-path semantics were unsafe and undocumented.** `tags: []` silently cleared every tag on a ticket, and all three write tools were annotated `destructiveHint: false` — including one that sends an irreversible public reply.

**Overall verdict: 44 findings — 4 High, 20 Medium, 19 Low, 1 Info** across security (14), maintainability (14) and usability (15), plus 1 Info. 36 are fixed and merged, 1 was closed by decision, and **7 remain open** with a filed issue for each.

**Current state after the fixes of this round:**
- Both credential leaks are **merged** — PR #29 for the setup path and PR #71 for the runtime path.
- The security and correctness findings are merged; §8 says which pull request each one landed in.
- **41 issues** filed, `#30`–`#70`, mapped to findings in §8.
- **Seven findings are still open**, each with a filed issue: M1, M2, M6, M7, M8, M11 and M13.

---

## 2. Prioritised action list

> **Status after the fixes of this round.** Items 1 and 2 below are **done**: S1 merged via PR #29, and S0/P1/P2/M12 merged in PR #71. Every finding in the list below has a filed issue (`#30`–`#70`) — see §8 for the mapping and for where each one landed.

| Rank | ID | Severity | Area | Title |
|---|---|---|---|---|
| 1 | S1 | High | Security | Token-exchange failure prints the raw access token to stderr |
| 2 | U1 | High | Usability | `commentUsers` is always `undefined` — the side-load is never requested |
| 3 | U4 | Medium | Usability | Console `load()` has no `catch`; a transport failure renders a normal-looking empty dashboard |
| 4 | M4 | Medium | Maintainability | `tags: []` silently clears every tag on a ticket |
| 5 | M3 | Medium | Maintainability | `destructiveHint: false` hardcoded for all three write tools |
| 6 | U2 | Medium | Usability | Search mislabels user/organization results as tickets |
| 7 | S2 | Medium | Security | Token-file write follows a pre-planted symlink |
| 8 | S3 | Medium | Security | Console has no Host/origin validation (DNS rebinding) |
| 9 | S4 | Medium | Security | `redact()` matches key names only; string values are never scrubbed |
| 10 | M5 | Medium | Maintainability | `npm run e2e:mock` never runs in CI |
| 11 | M1 | Medium | Maintainability | The tool list is written out by hand in twelve files |
| 12 | M2 | Medium | Maintainability | `safeJson` triplicated; `errorMessage` and mode predicates duplicated |

---

## 3. Security findings

### S1 — High — Token-exchange failure prints the raw access token to stderr

**Disposition: merged in PR #29.**

**Confirmed (reproduced by the security reviewer with a live mock exchange).**
`plugins/zendesk-connector/src/oauth-setup.ts:597-601`

```ts
  if (!response.ok || !isTokenResponse(payload)) {
    throw new Error(
      `Zendesk token exchange failed: HTTP ${response.status} ${JSON.stringify(payload)}`,
    );
  }
```

`payload` is the **unredacted** response body from `POST {baseUrl}/oauth/tokens`. A 200 response that fails the shape check (for example a body missing `refresh_token`) therefore places a live, write-scoped access token into the thrown error message.

**Impact.** The failure path never writes the token to the token file, so **the printed copy is the only copy** — into shell scrollback, a CI log, or an agent transcript. A secondary variant: an intercepting proxy or error page that echoes the request body would inline the `client_secret` sent in the same POST (`oauth-setup.ts:584-593`).

**Fix already exists.** `origin/ci/oauth-exchange-redaction` (`ed5b30d`, "fix: redact the token-exchange error body") wraps the payload in `redact()`. It is open as **PR #29** and is not an ancestor of `main`.

**Remediation.**
1. Merge PR #29.
2. Additionally stop inlining bodies: log only the HTTP status plus a shape summary (`has access_token`, `has refresh_token`).
3. Fix S4 as well — the PR alone does **not** fully close this, because `redact()` returns a raw non-JSON string unchanged (see S4).

---

### S2 — Medium — Token-file write follows a pre-planted symlink

**Disposition: merged in PR #73.**

**Confirmed (reproduced).** `plugins/zendesk-connector/src/auth.ts:593-605`

```ts
export async function writeTokenFile(
  tokenFile: string,
  token: StoredToken,
): Promise<void> {
  const directory = dirname(tokenFile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${tokenFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(token, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, tokenFile);
  await chmod(tokenFile, 0o600);
}
```

`writeFile` without `flag: "wx"` follows an existing symlink. The temp path is predictable (`${tokenFile}.${process.pid}.tmp`), and `mkdir(..., { recursive: true })` does **not** change the mode of a directory that already exists — so a pre-existing, world-writable `~/.config/codex-zendesk/` lets a local attacker plant the symlink and capture both the access and refresh tokens on the next refresh.

**The asymmetry is the tell.** The project already solved this exact problem for the *client secret* file and documented it (`oauth-setup.ts:717-734`):

```ts
/**
 * ... The name is predictable, so a link may already sit there. The write uses
 * the exclusive flag, so it fails instead of following the link; ...
 */
async function writeTemporaryFile(
  temporary: string,
  body: string,
): Promise<void> {
  try {
    await writeFile(temporary, body, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    await rm(temporary, { force: true });
    await writeFile(temporary, body, { mode: 0o600, flag: "wx" });
  }
}
```

The token writer — which holds strictly more sensitive material — got neither the defence nor the reasoning.

**Remediation.** Reuse `writeTemporaryFile` for the token write (move it to a shared module), or add `flag: "wx"` with the same remove-and-retry handling. Verify the token directory's mode explicitly rather than relying on `mkdir`'s `mode` option.

---

### S3 — Medium — Operations console has no Host/origin validation (DNS rebinding)

**Disposition: merged in PR #75.**

**Confirmed in code; the exploit was not executed.**
`apps/operations-console/server.mjs:350` binds loopback only:

```js
  app.listen(port, "127.0.0.1", () => {
    console.log(`Service Operations running at http://127.0.0.1:${port}`);
  });
```

—but there is **no `Host` header check, no `Origin` check and no CORS policy anywhere in the file**. `GET /api/overview` (`server.mjs:262-293`) returns live ticket subjects, assignees, request types, counts and the account URL with no authentication of any kind.

**Impact.** A DNS-rebinding page resolves an attacker-controlled hostname to `127.0.0.1` and issues a same-origin `GET` to `/api/overview`; the browser treats it as same-origin to the attacker's page and reads the response. Loopback binding does not defend against this class of attack, because the request still originates from the victim's browser.

**Remediation.** Validate the `Host` header against an allowlist of `127.0.0.1:{port}` / `localhost:{port}` before routing. Note that Chrome's Private Network Access protections partially mitigate this today; treat the Host check as the durable fix, not the mitigation.

---

### S4 — Medium — `redact()` matches key names only; string values are never scrubbed

**Disposition: merged in PR #73.**

**Confirmed.** `plugins/zendesk-connector/src/audit.ts:127-138`

```ts
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => {
      if (/token|secret|password|authorization|cookie/i.test(key)) {
        return [key, "[REDACTED]" satisfies AuditValue];
      }
      return [key, redact(child)];
    }),
  );
}
```

The guard `typeof value !== "object"` returns string values **unchanged**. `redact({access_token:"AT-111"})` → `{"access_token":"[REDACTED]"}`; `redact("access_token=AT-111 raw body")` → unchanged.

**Impact.** This is the enabling condition for S1, and it means the PR #29 fix is incomplete on its own: a **non-JSON** token-exchange body is still inlined verbatim. It is also a latent trap for any future string-valued sink.

**What this does *not* break.** Because `redact()` recurses into objects, nested token keys inside `ZendeskError.details.response` **are** correctly masked. The object path is sound; only string sinks are affected.

**Remediation.** Never route a raw body into an error message (see S1). If bodies must be surfaced, scrub credential-shaped substrings within strings as a second layer rather than relying on key names.

---

### S5 — Low — The tool-call audit path skips `redact()` entirely

**Disposition: merged in PR #73.**

**Confirmed.** `plugins/zendesk-connector/src/audit.ts:75-82`

```ts
export function audit(event: Omit<AuditEvent, "event" | "timestamp">): void {
  const payload: AuditEvent = {
    event: "zendesk_tool_call",
    timestamp: new Date().toISOString(),
    ...event,
  };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}
```

Compare the other three log paths, all of which go through `writeEvent` (`audit.ts:140-142`):

```ts
function writeEvent(payload: unknown, sink: LogSink): void {
  sink(`${JSON.stringify(redact(payload))}\n`);
}
```

**Impact.** Not exploitable today — the audit event fields (`tool`, `operation`, `outcome`, `status`, `actorId`) carry no credential material. But this is the **one** sink in the codebase without the house filter, it is the sink with the highest volume (one line per tool call), and it has no redaction test (`audit.test.ts` asserts redaction for `logServerShutdown` only). Any future field carrying a token would leak silently.

**Remediation.** Route `audit()` through `writeEvent` and add a redaction test for it.

---

### S6 — Low — Console mints a `read write` scope for a read-only app

**Disposition: merged in PR #75.**

**Confirmed.** `apps/operations-console/server.mjs:158-177`

```js
async function requestToken() {
  const path = process.env.ZENDESK_OAUTH_CLIENT_FILE ||
    join(homedir(), ".config", "codex-zendesk", "client.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  const baseUrl = config.baseUrl || `https://${config.subdomain}.zendesk.com`;
  const response = await fetch(`${baseUrl}/oauth/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: "read write",
    }),
  });
```

Three problems in one block:

1. The console is a **read-only** app (every endpoint is a `GET`), yet it requests write scope.
2. It **ignores `ZENDESK_OAUTH_SCOPE`** and the `scope` field in `client.json`. The connector's default is `"tickets:read tickets:write users:read organizations:read brands:read groups:read"` (`auth.ts:16-17`, resolved at `auth.ts:200`). An operator who deliberately narrowed the scope to read-only still gets a write-capable console token.
3. `"read write"` is not a Zendesk scope string — Zendesk scopes are `tickets:read`, `tickets:write`, `users:read`, etc. The behaviour of the token endpoint on an unrecognised scope string is not defined by the connector and is not covered by a test.

**Remediation.** Read the scope from the same resolution chain the connector uses (`ZENDESK_OAUTH_SCOPE` → `client.json` → connector default), and request only read scopes.

---

### S7 — Low — Console performs no base-URL validation

**Disposition: merged in PR #75.**

**Confirmed.** `apps/operations-console/server.mjs:162`

```js
  const baseUrl = config.baseUrl || `https://${config.subdomain}.zendesk.com`;
```

The connector enforces HTTPS (`auth.ts:607-613`):

```ts
function validateBaseUrl(value: string): string {
  const url = new URL(value);
  const isLocalhost =
    url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost)) {
    throw new ZendeskAuthError(
      "ZENDESK_BASE_URL must use HTTPS (HTTP is allowed only for localhost).",
```

The console accepts **any** scheme and host from `client.json` — including `http://` — and will POST the `client_secret` to it. The file is operator-owned, so this is not directly attacker-controlled, but the two halves of the project disagree about the trust boundary.

**Remediation.** Apply the same `validateBaseUrl` rule to the console's base URL.

---

### S8 — Low — Raw error messages are returned to the browser

**Disposition: merged in PR #75.**

**Confirmed.** `apps/operations-console/server.mjs:295-300`

```js
  } catch (error) {
    response.status(503).json({
      connected: false,
      error: error instanceof Error ? error.message : "Zendesk is unavailable",
    });
  }
```

`requestToken()` parses the client file with `JSON.parse(await readFile(path, "utf8"))` (`server.mjs:161`). V8's parse errors inline the input — e.g. `JSON.parse("abc")` yields `Unexpected token 'a', "abc" is not valid JSON`. A client file that is corrupt and does not begin with `{` or `[` (a BOM, for instance) would place its **leading bytes — potentially the client id or secret** — into a browser-visible response, reachable via S3.

**Remediation.** Return a fixed message to the browser; log the detail server-side.

---

### S9 — Low — `/api/*` endpoints are not rate-limited *(deliberate, not a bug)*

**Disposition: merged in PR #78.**

**Confirmed and intentional.** `server.mjs:253` and `:262` register the API routes **before** `mountStaticFiles` (`server.mjs:306-323`) installs the limiter, so Express never applies the limiter to them. This is a deliberate, tested design decision — `apps/operations-console/test/rate-limit.test.mjs:368` asserts the limiter "leaves the routes that were mounted before it alone."

**Why it is still worth a decision:** `/api/overview` triggers live Zendesk reads, and it is the one route that is *not* limited. In development mode the limiter is not installed at all. Record the intent explicitly rather than leaving it as an emergent property of route ordering.

---

### S10 — Low — No PKCE in the `authorization_code` flow *(acknowledged in the docs)*

**Disposition: closed by decision.**

**Confirmed.** `oauth-setup.ts:463-475` builds the authorization URL with `response_type`, `client_id`, `scope` and `state` — no `code_challenge`; `exchangeCode` sends no `code_verifier`.

This is a **confidential client** (it sends `client_secret`, `oauth-setup.ts:588`), and `docs/secrets-and-storage.md` already records the decision that PKCE does not apply. Listed here for completeness only.

---

### S11 — Low — `zendesk_status` discloses the token-file path

**Disposition: merged in PR #73.**

**Confirmed.** `auth.ts:370-378` — `status()` returns `tokenFile` (in `authorization_code` mode; `undefined` otherwise), surfaced directly in the `zendesk_status` tool result. Path only, no credential, but it is filesystem information reaching an LLM that will likely repeat it in a summary. `docs/tool-contracts.md` documents the payload as including `oauth` and `baseUrl` but not the path.

**Remediation.** Return the directory basename or omit the field from the tool payload while keeping it in the CLI/`doctor` output.

---

### S12 — Info — CI falls back to self-hosted runners if the guard variable is deleted

**Disposition: merged in PR #76.**

**Confirmed.** `ci.yml:71, 96, 169, 208, 298` use a pattern equivalent to:

```yaml
runs-on: ${{ fromJSON(vars.LINUX_RUNNER_LABELS || '["self-hosted", ...]') }}
```

`AGENTS.md:44` documents this and instructs that `LINUX_RUNNER_LABELS` (currently `["ubuntu-latest"]`) must not be deleted or changed — because deleting it would put public pull-request code on operator hardware.

**The guard is fail-open.** For a safety control on a public repository, the safe default is to **fail the job**, not to fall back to self-hosted. As long as the variable exists the behaviour is correct; the risk is only materialised if it is ever removed.

**Remediation.** Make the workflow fail with a clear message when `LINUX_RUNNER_LABELS` is unset, rather than substituting a self-hosted label list.

---

## 4. Maintainability findings

### M1 — Medium — The tool list is written out by hand in twelve files

**Disposition: open — deferred refactor.**

**Confirmed.** A repository-wide grep for the tool names returns **293 occurrences across 21 files**. Files that carry the tool set by hand:

| File | Occurrences |
|---|---|
| `docs/tool-contracts.md` | 41 |
| `docs/single-tenant-deployment.md` | 30 |
| `plugins/zendesk-connector/README.md` | 27 |
| `README.md` | 15 |
| `AGENTS.md` | 12 |
| `plugins/zendesk-connector/e2e/run-e2e.mjs` | 10 |
| `plugins/zendesk-connector/.env.example` | 9 |
| `docs/operations.md` | 6 |
| `CHANGELOG.md` | 6 |
| `SECURITY.md` | 4 |
| `docs/multi-user-oauth-isolation.md` | 3 |
| `docs/secrets-and-storage.md` | 1 |

Three of them name a single tool: `docs/operations.md`, `docs/multi-user-oauth-isolation.md` and
`docs/secrets-and-storage.md`.

plus the code itself (`plugins/zendesk-connector/src/server.ts` — 48, `src/policy.ts` — 15).

**Impact.** The tool list is the single most consequential fact in the product and it is maintained in twelve places by hand. Adding, removing or renaming a tool silently desynchronises the documentation, the read-only allowlist, the `.env.example` comment, and `AGENTS.md`. `docs/tool-contracts.md`, the root `README.md` and `plugins/zendesk-connector/README.md` each carry their own copy of the 12-tool table.

**Remediation.** Make `policy.ts`'s `ALL_TOOLS` the single source of truth and generate the tool tables and the `.env.example` read-only list from it (`scripts/` already contains `check-changelog.mjs`, so a generator fits the existing pattern).

---

### M2 — Medium — `safeJson` triplicated; `errorMessage` and mode predicates duplicated

**Disposition: open — deferred refactor.**

**Confirmed.** Identical helper bodies in three modules:

| Helper | Locations |
|---|---|
| `safeJson` | `auth.ts:631`, `client.ts:147`, `oauth-setup.ts:666` |
| `errorMessage` | `doctor.ts:328`, `oauth-setup.ts:882` |
| mode predicate | `auth.ts:309` (`isOAuthMode`), `oauth-setup.ts:877` (`isKnownMode`) |

The mode predicates are the sharpest example — `isOAuthMode` and `isKnownMode` are the same function under two names, one in each module, with no shared definition:

```ts
// auth.ts:309
function isOAuthMode(value: string): value is OAuthMode {
  return (OAUTH_MODES as readonly string[]).includes(value);
```

```ts
// oauth-setup.ts:877
function isKnownMode(value: string): value is OAuthMode {
  return (OAUTH_MODES as readonly string[]).includes(value);
```

**Impact.** Four copies of the "is this a valid OAuth mode?" rule. Adding a mode requires editing both, and forgetting one produces a setup path that accepts a mode the server refuses.

**Remediation.** Extract a `src/json.ts` and `src/errors.ts` (or one `src/internal.ts`) and import from both.

---

### M3 — Medium — `destructiveHint: false` is hardcoded for all three write tools

**Disposition: merged in PR #74.**

**Confirmed.** `plugins/zendesk-connector/src/server.ts:467-474`

```ts
function writeAnnotations(idempotent: boolean) {
  return {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: idempotent,
    openWorldHint: true,
  } as const;
}
```

Applied to `zendesk_create_ticket`, `zendesk_update_ticket` (`server.ts:194`, `writeAnnotations(true)`) and `zendesk_add_ticket_comment`. **`destructiveHint: false` tells an MCP host that the tool performs only additive updates**, which is false for two of the three:

- `zendesk_add_ticket_comment` sends an **irreversible public reply** to a customer.
- `zendesk_update_ticket` can change status, priority and type, and can wipe all tags (see M4).

**Impact.** A host that honours these hints may skip a confirmation prompt for a destructive, customer-visible action.

**Remediation.** `destructiveHint: true` for `zendesk_update_ticket` and `zendesk_add_ticket_comment`. Note `AGENTS.md:46` already states "MCP tool annotations are hints, not access control" — the annotations should at least not assert something false.

---

### M4 — Medium — `tags: []` silently clears every tag on a ticket

**Disposition: merged in PR #74.**

**Confirmed.** Two lines interact.

`server.ts:199` — the "at least one update field" guard:

```ts
        if (Object.values(updates).every((value) => value === undefined)) {
          throw new ZendeskError("No update fields were provided.");
        }
```

`tags: []` is **not** `undefined`, so it passes the guard. `server.ts:501` — the payload builder:

```ts
  if (input.tags) ticket.tags = input.tags;
```

In JavaScript `[]` is **truthy**, so `tags: []` is assigned and sent as `tags: []`, which tells Zendesk to **remove every tag** on the ticket.

**Impact.** Two realistic paths:
1. An agent is asked to "make sure the ticket has no stale tags" and sends `tags: []` — correct intent, destructive but expected.
2. An agent must supply "at least one update field" but wants a no-op-ish update. `tags: []` is the minimal way to satisfy the schema, and it silently destroys every tag. The tool offers **no** way to express "leave tags alone".

The schema (`server.ts:192`, `tags: z.array(z.string()).optional()`) permits an empty array, and `docs/tool-contracts.md:30` documents only "`tags` array of strings (optional)" — the clearing semantics appear nowhere.

**Remediation.** Reject an empty `tags` array explicitly (`z.array(z.string()).min(1)`), or treat `[]` as "no change". Whichever is chosen, document it in `docs/tool-contracts.md`.

---

### M5 — Medium — `npm run e2e:mock` never runs in CI

**Disposition: merged in PR #76.**

**Confirmed.** `plugins/zendesk-connector/package.json` defines:

```json
"check": "npm run typecheck && npm test",
"e2e:mock": "node --test ./e2e/mock.test.mjs",
```

and `.github/workflows/ci.yml:43` runs only `npm run check`. The hermetic end-to-end harness never gates a merge.

This is a missed opportunity, not a broken build: `e2e/mock.test.mjs` is genuinely hermetic — it binds an ephemeral loopback port (`server.listen(0, "127.0.0.1", resolve)`, line 315) with a mock Zendesk and a `DUMMY_TOKEN`, and requires no network and no credentials:

```js
      ZENDESK_BASE_URL: `http://127.0.0.1:${mock.port}`,
      ZENDESK_OAUTH_ACCESS_TOKEN: DUMMY_TOKEN,
```

The suite covers the **read** tools only — no write tool name (`zendesk_create_ticket`, `zendesk_update_ticket`, `zendesk_add_ticket_comment`) appears in `e2e/mock.test.mjs`.

**Remediation.** Add `npm run e2e:mock` to `npm run check` or as a separate CI step. Extending the harness to the write tools would then catch M4 and M3 for free.

---

### M6 — Low — `client.ts:110` performs an unsound generic cast

**Disposition: open — deferred refactor.**

**Confirmed.** `plugins/zendesk-connector/src/client.ts:109-110`

```ts
      return payload as T;
```

`payload` is the parsed JSON of an untrusted API response, cast to the caller's generic `T` with no validation. Every `client.request<T>()` call site therefore trusts that the response has the declared shape.

**Remediation.** Validate with a schema (Zod is already a dependency) at the boundary, at least for the tools whose payloads are consumed structurally.

---

### M7 — Low — `oauth-setup.ts` uses global `fetch`, bypassing the injectable fetcher

**Disposition: open — deferred refactor.**

**Confirmed.** `oauth-setup.ts:578`

```ts
  const response = await fetch(`${config.baseUrl}/oauth/tokens`, {
```

Every other HTTP call site in the project injects a fetcher so tests can substitute one (`client.ts`, `auth.ts`). `oauth-setup.ts:578` is the sole exception, which is why the S1 leak could only be reproduced out-of-process.

**Remediation.** Accept an optional `fetchImpl` in `exchangeCode`'s options, matching the rest of the codebase.

---

### M8 — Low — Environment-variable handling has four access styles and four validation policies

**Disposition: open — deferred refactor.**

**Confirmed.** Across `auth.ts`, `policy.ts`, `client.ts` and the console's `server.mjs`:

- Four ways to read an env var: bare `process.env.X`, the `env()` helper, `??` chains against the saved client file, and direct `process.env` reads in the console (`server.mjs:65`).
- Four different policies for an *unknown* value: `auth.ts` throws on an unrecognised `ZENDESK_OAUTH_MODE`; `policy.ts` throws on an unrecognised `ZENDESK_READ_ONLY`; `client.ts` silently falls back to the default for a retry limit that is not an integer in range; the console treats an empty string as absent (`configValue`, `server.mjs:64-69`).

**Impact.** An operator who typos `ZENDESK_OAUTH_MODE` gets a hard error, while an operator who typos `ZENDESK_MAX_RETRIES` gets the default without being told.

Issue #52 was filed with the earlier wording, which named the wrong reader for the mode
and the wrong variable for the client. The correction is recorded on the issue.

**Remediation.** One `env()` helper with one documented policy per variable.

---

### M9 — Low — `.env.example` documents 8 of ~16 `ZENDESK_*` variables

**Disposition: merged in PR #78.**

**Confirmed.** `plugins/zendesk-connector/.env.example` was 12 lines and listed: `ZENDESK_SUBDOMAIN`, `ZENDESK_OAUTH_MODE`, `ZENDESK_OAUTH_CLIENT_ID`, `ZENDESK_OAUTH_CLIENT_SECRET`, `ZENDESK_OAUTH_CLIENT_FILE`, `ZENDESK_OAUTH_SCOPE`, `ZENDESK_ALLOWED_TOOLS`, `ZENDESK_READ_ONLY`.

Not in that file then: `ZENDESK_BASE_URL`, `ZENDESK_OAUTH_ACCESS_TOKEN`, `ZENDESK_OAUTH_TOKEN_FILE`, `ZENDESK_MAX_RETRIES`, `ZENDESK_MAX_RETRY_DELAY_MS`, `ZENDESK_OAUTH_CALLBACK_PORT`, `ZENDESK_HEALTHCHECK`, `ZENDESK_SHUTDOWN_TIMEOUT_MS`. The `ZENDESK_CONSOLE_*` variables live only in the console's own `.env.example`.

`ZENDESK_MAX_RETRIES` and `ZENDESK_MAX_RETRY_DELAY_MS` were in the root README's configuration table then, so an operator could find them there — but not their bounds, and not the rest of the list. That is what the file's absence cost: the example file was the only place an operator would look for a complete list.

Note `.mcp.json` does list a wider set, so the manifest and the example file disagree about what a user must fill in.

---

### M10 — Low — The console duplicates domain constants between server and frontend

**Disposition: merged in PR #79.**

**Confirmed.**

| Constant | Server | Frontend |
|---|---|---|
| "Unclassified" | `server.mjs:46` (`UNCLASSIFIED`) | `src/lib/tickets.mjs:10` (`UNCLASSIFIED_REQUEST_TYPE`) |
| "Not specified" | `server.mjs:234` (inline literal) | `src/lib/tickets.mjs:13` (`UNSPECIFIED_SYSTEM`) |

The console's server and frontend are separate packages with no shared module, so these drift silently.

---

### M11 — Low — `server.ts` concentrates 12 tool definitions in one large function

**Disposition: open — deferred refactor.**

**Confirmed.** `plugins/zendesk-connector/src/server.ts` is ~560 lines; `createZendeskServer` is a single ~450-line function containing 12 inline `allowedTools.has("...") && server.registerTool("...", { ... }, async () => { ... })` expressions, plus `buildTicketPayload` (`server.ts:488-510`) and the annotation helpers (`server.ts:460-474`).

Each tool is individually testable through the in-memory MCP transport, which is why the test suite is strong — but the file is the natural place for drift, and it is the file that carries M3, M4, U1, U2 and U3.

**Remediation.** One module per tool (or per tool group), with a shared registration helper.

---

## 5. Usability findings

### U1 — High — `commentUsers` is always `undefined`

**Disposition: merged in PR #74.**

**Confirmed.** `plugins/zendesk-connector/src/server.ts:132-143`

```ts
        const commentsResponse = await client.request<{
          comments: JsonObject[];
          users?: JsonObject[];
          next_page?: string | null;
        }>(`/tickets/${id}/comments.json`);

        return {
          ...ticketResponse,
          comments: commentsResponse.comments,
          commentUsers: commentsResponse.users,
          commentsTruncated: Boolean(commentsResponse.next_page),
          agent_url: ticketUrl(client, id),
        };
```

The comments request at **line 136** passes **no query string** — `include=users` is never sent — so `commentsResponse.users` is always `undefined` and `commentUsers` is always `undefined`.

The contrast is within the same handler, nine lines earlier (`server.ts:124-126`), where the ticket request **does** side-load:

```ts
        }>(`/tickets/${id}.json`, {
          query: { include: "users,organizations" },
        });
```

**Impact.** Comment authors come back as bare `author_id` values. The field is dead code that a consumer will reasonably believe is populated — and the shipped contract **promises** it is populated. `docs/tool-contracts.md:105` states:

```
- `commentUsers`: the users referenced by that page of comments.
```

So the documentation guarantees a side-load that the code never requests. Any consumer written against the contract — including an agent reading the tool docs — will treat `commentUsers` as reliable and will get `undefined` instead.

**Remediation.** Add `query: { include: "users" }` to the comments request. Note the Zendesk side-load must be requested on the **comments** endpoint, not inherited from the ticket request.

---

### U2 — Medium — `zendesk_search_tickets` mislabels non-ticket results as tickets

**Disposition: merged in PR #74.**

**Confirmed against Zendesk's API documentation.** `server.ts:78-101`

```ts
        const response = await client.request<{
          results: JsonObject[];
          count?: number;
          next_page?: string | null;
        }>("/search.json", {
          query: { query, page, per_page: perPage },
        });

        return {
          count: response.count,
          page,
          perPage,
          nextPageAvailable: Boolean(response.next_page),
          results: response.results.map((ticket) => {
            const id = ticketId(ticket);
            return {
              ...ticket,
              agent_url: id ? ticketUrl(client, id) : undefined,
            };
          }),
        };
```

Zendesk's Search API is a unified endpoint: the `results` array "may consist of tickets, users, groups, or organizations, as specified by the `result_type` property in each result object", and a search without a `type:` qualifier returns **all** result types. `result_type` appears **nowhere** in this codebase — the loop treats every entry as a ticket and synthesises `agent_url` from `result.id`.

**Impact.** A search without `type:ticket` returns user and organization rows wearing a fabricated `/agent/tickets/<userId>` URL. The tool is named `zendesk_search_tickets`, so a consumer has no reason to doubt the rows.

**Remediation.** Either force `type:ticket` into the query, or filter on `result_type` and surface it in the output. The tool's own description already hints at it — *"Include type:ticket unless searching broadly"* (`server.ts:67`) — but a tool whose name asserts the type should enforce it rather than depend on the caller's memory.

---

### U3 — Medium — Truncated comments have no continuation path

**Disposition: merged in PR #74.**

**Confirmed.** `server.ts:136` fetches `/tickets/${id}/comments.json` with no `page` parameter, and `server.ts:142` returns `commentsTruncated: Boolean(commentsResponse.next_page)`.

The tool has no comment-page parameter (`server.ts:111-114` accepts only `ticketId` and `includeComments`), so when a thread has more comments than fit on one page, the remaining comments are **unreachable**.

**Compounding issue.** The description (`server.ts:110`) says *"and recent comments"*, but Zendesk returns the **oldest** comments first — page 1 is the start of the thread, not the end. `docs/tool-contracts.md:104` states "first page" correctly. **Two shipped surfaces disagree about which comments you get.**

**Remediation.** Add a `commentPage` parameter and return the next page's URL, or drop the truncation flag until a continuation exists. Correct the description to match the contract.

---

### U4 — Medium — Console `load()` has no `catch`; a transport failure renders a normal-looking empty dashboard

**Disposition: merged in PR #80.**

**Confirmed.** `apps/operations-console/src/App.tsx:210-218`

```tsx
  const load = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/overview");
      const payload = await response.json();
      setData(toOverviewState(payload));
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
```

There is a `try`/`finally` but **no `catch`**. If `fetch` rejects (server down) or `response.json()` throws (an HTML error page instead of JSON), `setData` never runs, the promise rejects unhandled at both call sites — `useEffect(() => { load(); }, [])` (line 218) and the refresh button's `onClick={load}` (line 235) — and the console renders `EMPTY_OVERVIEW`.

**Impact.** The operator sees **"0 tickets, no blockers"** and cannot distinguish "this account has no tickets" from "the connector is unreachable". The sidebar footer falls back to the generic `"Check OAuth configuration"` (`src/lib/overview.mjs:74`), which points at the wrong cause entirely.

**Remediation.** Add a `catch` that sets an explicit error state, and render it as a prominent banner rather than a footer line.

---

### U5 — Medium — The search tool's description omits pagination, result shape and the ticket-id handoff

**Disposition: merged in PR #74.**

**Confirmed.** `server.ts:61-74` — the description is:

```
"Search Zendesk tickets with Zendesk search syntax. Example: type:ticket status<solved priority:high."
```

It does not say that the response is paginated, that `count` is the **total across all pages** while `results` is one page, that `page`/`perPage` exist, or that `zendesk_get_ticket` is the next step. An agent that reads `count: 250` and `results.length: 25` has no stated way to reconcile them, and no instruction to paginate.

**Remediation.** State the shape and the continuation, e.g. "Returns one page of tickets. `count` is the total number of matches; call again with `page` to continue. Pass the returned ticket `id` to `zendesk_get_ticket` for full detail."

---

### U6 — Medium — Write-tool descriptions are 5 words; parameters are undescribed

**Disposition: merged in PR #74.**

**Confirmed.**

- `server.ts:152` — `zendesk_create_ticket`: `"Create a Zendesk ticket."` No parameter descriptions, no statement that the result contains the new ticket id, no warning that the ticket is customer-visible.
- `server.ts:184-185` — `zendesk_update_ticket`: `"Update common Zendesk ticket fields. Provide only fields that should change."` It never says **which** fields — an agent asked to reassign a ticket gets an opaque zod validation error for `assigneeId`.
- `server.ts:214` — `zendesk_add_ticket_comment`: `"Add a public reply or internal note to a Zendesk ticket."` The `public` flag is well described (`server.ts:218-221`, *"False creates an internal note."*), but the description does not say that a **public reply is irreversible and customer-visible**. The `body` and `ticketId` parameters carry no `.describe()` at all.

The server-level `instructions` string (`server.ts:20-21`) is genuinely good — *"Use read tools to inspect Zendesk before making changes. Treat create, update, and comment tools as external writes. Internal notes default to non-public. Never expose OAuth credentials or raw token files in tool output."* — but it sets session-level policy. The **per-tool** contract is where a model chooses a tool and fills its arguments, and that is where these three are thinnest.

**Remediation.** Expand the three write-tool descriptions: name the updatable fields, describe each parameter, state the return shape, and say what the tool does not do.

---

### U7 — Medium — No `--help`; an unknown flag starts the stdio server and hangs

**Disposition: merged in PR #77.**

**Confirmed.** `plugins/zendesk-connector/src/index.ts:14-47` dispatches only on `--doctor`, `--healthcheck` and `--logout` (via `isDoctorRequested`, `isHealthCheckFlag`, `isLogoutRequested`). Any other argument — including `--help` — falls through to:

```ts
    const server = createZendeskServer();
    ...
    await server.connect(new StdioServerTransport());
```

The process then waits on stdin **forever**, with no output. `zendesk-mcp --help` and `npm start -- --help` both hang silently, which reads as a broken install.

**Remediation.** Handle `--help`/`-h` explicitly and print usage; treat any unrecognised flag as an error rather than falling through to the server.

---

### U8 — Medium — The doctor cannot detect the most common setup failure, and never prints the enabled tool set

**Disposition: merged in PR #77.**

**Confirmed.** `plugins/zendesk-connector/src/doctor.ts:71-84` states its scope explicitly:

```
 * Runs every doctor check without contacting Zendesk and returns one
 * actionable message per failing check, in check order.
 *
 * Checks, in order: the OAuth configuration (the same validation startup
 * performs, including the client file's permission requirement), the tool
 * policy, the setup callback port, and the authorization-code token file.
```

`checkDoctor` (`doctor.ts:85-114`) implements exactly those four. It therefore **cannot** detect:

- a scope the Zendesk client was never granted (the most common setup failure, per the `HTTP 403` troubleshooting row at `README.md:433`) — it validates the *configuration*, not the *grant*;
- a token that is expired or revoked;
- a wrong redirect URI registered in the Zendesk admin;
- an unreachable subdomain.

It also **never prints which tools are enabled.** `doctor.ts:98-102` calls `configuredTools()` purely to surface a configuration error:

```ts
  try {
    configuredTools();
  } catch (error) {
    problems.push(errorMessage(error));
  }
```

On success it prints only `"Zendesk connector doctor: all checks passed."` (`doctor.ts:137`). An operator cannot confirm what the agent will actually receive without starting the server and listing tools.

**Remediation.** Add a `--list-tools` / `doctor --tools` mode that prints the resolved tool set, the effective scope, the base URL and the token expiry. A single optional authenticated reachability check would catch the scope failure the offline preflight cannot.

---

### U9 — Medium — The console requires 7 configuration IDs but needs 5 for data

**Disposition: merged in PR #79.**

**Confirmed.** `apps/operations-console/server.mjs:48-56`

```js
const REQUIRED_CONFIG = {
  brandId: "ZENDESK_CONSOLE_BRAND_ID",
  requestTypeFieldId: "ZENDESK_CONSOLE_REQUEST_TYPE_FIELD_ID",
  systemFieldId: "ZENDESK_CONSOLE_SYSTEM_FIELD_ID",
  openViewId: "ZENDESK_CONSOLE_VIEW_OPEN_ID",
  untriagedViewId: "ZENDESK_CONSOLE_VIEW_UNTRIAGED_ID",
  agingViewId: "ZENDESK_CONSOLE_VIEW_AGING_ID",
  requestTypeViewId: "ZENDESK_CONSOLE_VIEW_REQUEST_TYPE_ID",
};
```

`readConfig()` throws when **any** of the seven is missing. But `/api/overview` (`server.mjs:262-293`) only *fetches* from `config.views.aging` and `config.views.untriaged`; `openViewId` and `requestTypeViewId` are used solely to build hyperlinks (`server.mjs:288-291`).

**Impact.** A missing `ZENDESK_CONSOLE_VIEW_OPEN_ID` — needed only for a link — makes the **entire dashboard 503**. The operator sees an error for what looks like a data problem.

**Remediation.** Split required-for-data from optional-for-links, and surface the missing optional IDs as a warning.

---

### U10 — Medium — Two shipped surfaces disagree about which comments are returned

**Disposition: merged in PR #74.**

**Confirmed.** `server.ts:110` says *"and recent comments"*; `docs/tool-contracts.md:104` says *"first page"*. Only the contract is correct (see U3).

---

### U11 — Low — No `logout` or `healthcheck` npm script, though both flags exist

**Disposition: merged in PR #78.**

**Confirmed.** `plugins/zendesk-connector/package.json` scripts are `clean`, `build`, `build:test`, `typecheck`, `test`, `check`, `start`, `doctor`, `e2e`, `e2e:mock`, `oauth:setup`, `prepack`.

`--logout` and `--healthcheck` both work as flags on `dist/index.js` (`index.ts:22-30`), but the operator must know to run `node dist/index.js --logout` — and revoking local credentials is exactly the step an operator looks for when something goes wrong.

**Remediation.** Add `"logout"` and `"healthcheck"` scripts.

---

### U12 — Low — The plugin manifest uses a relative path for the server entrypoint

**Disposition: merged in PR #78 — the plugin README and the root README now say that the
path is relative to the plugin root and name the absolute path a host has to use. The
manifest itself is unchanged.**

**Confirmed.** `plugins/zendesk-connector/.mcp.json:5-7`

```json
      "command": "node",
      "args": [
        "./dist/index.js"
      ],
```

MCP hosts resolve relative paths against their **own** working directory, not the plugin directory. Whether the plugin starts therefore depends on the host's cwd handling — a host-dependent failure mode.

**Remediation.** Use an absolute path resolved at install time, or verify against the target hosts that the relative form is resolved relative to the plugin root.

---

### U13 — Low — The console's workstream statuses are hard-coded literals

**Disposition: merged in PR #80.**

**Confirmed.** `apps/operations-console/src/App.tsx:96-104`

```tsx
            ["Program intake", "Program and product conditional workflow", "Protected", "neutral"],
            ["Help Center structure", "Program, intake, and product areas", "In progress", "warn"],
            ["Slack learning", "Two channels queued for synthesis", "Ready to ingest", "warn"],
            ["Explore reporting", "Aging and request-type dashboards", "Sign-in needed", "risk"],
```

The app asserts operational facts it never measured. It is a reference app, so this may be intentional — but it is indistinguishable, in the UI, from real measured status.

**Remediation.** Label the section explicitly as illustrative, or source the values.

---

### U14 — Low — The console's two headline metrics are measured inconsistently

**Disposition: merged in PR #79.**

**Confirmed.** `server.mjs:279-284`

```js
      metrics: {
        active: summary.tickets.length,
        untriaged: untriagedView.count || 0,
        unassigned: summary.tickets.filter((ticket) => !ticket.assigneeId).length,
        oldestDays: Math.max(0, ...summary.tickets.map((ticket) => ticket.ageDays)),
      },
```

`active` counts the rows the aging view **returned**; `untriaged` uses the view's **`count`** (its true total). Above ~100 rows the two headline numbers disagree about the same quantity, and `unassigned` inherits the same truncation.

---

### U15 — Low — `Math.max(0, ...array)` risks a stack overflow on very large views

**Disposition: merged in PR #79.**

**Confirmed.** `server.mjs:283` — `Math.max(0, ...summary.tickets.map((ticket) => ticket.ageDays))` spreads the array as function arguments. Exceeding the engine's argument limit throws `RangeError: Maximum call stack size exceeded`, which the `catch` at `server.mjs:295` would convert into a 503 with the error message in the browser.

**Remediation.** Use `reduce` instead of a spread.

---

## 6. Findings from the parallel agent's review, independently re-verified by me

A second MiniMax agent in the same account ran the same review against the same
repository in parallel. Its four additional findings are recorded here because I
re-verified each one against source independently rather than on its word.

### S0 — High — Runtime token-exchange failure hands the raw body to the MCP agent

**Confirmed (re-verified by me at `auth.ts:421-437`).** This is the **runtime** half of S1 and is strictly more severe: S1 lives in the interactive `oauth:setup` path, S0 lives in the **server** path and therefore reaches the agent.

```ts
// auth.ts:421-437
const text = await response.text();
const payload = text ? safeJson(text) : undefined;
if (!response.ok) {
  throw new ZendeskAuthError(
    `Zendesk OAuth token request failed: HTTP ${response.status} ${response.statusText}`,
    response.status,
    payload,                      // <-- raw body, as `details`
  );
}

const received = payload as TokenResponse;
if (!received?.access_token) {
  throw new ZendeskAuthError(
    "Zendesk OAuth response did not include an access token.",
    response.status,
    payload,                      // <-- raw body, as `details`
  );
}
```

The message text is safe (status + statusText only). **The `details` argument is not.** It flows:

`ZendeskAuthError.details` → `server.ts:518-528` `errorResult` → `{ error, status, details }` → `redact()` (`audit.ts:127-138`) → the JSON the **agent reads**.

`redact()` masks values whose **key** matches `/token|secret|password|authorization|cookie/i`, so a body of

```json
{"error_description":"client_secret example-secret-value rejected"}
```

passes through **verbatim** — the key `error_description` does not match, and `redact()` never inspects what a value contains. The credential lands in the agent's context.

**Disposition: merged in PR #71** (`ecb704e`) — see §7. Filed as issue **#31**.

### M12 — Medium — The three write tools are never invoked by any test

**Confirmed (re-verified by me in `server.test.ts`).** In `server.test.ts` the write tools appear only in an **annotation assertion**:

```ts
    assert.equal(
      tools.tools.find((tool) => tool.name === "zendesk_create_ticket")
        ?.annotations?.readOnlyHint,
      false,
    );
```

The suite's only `callTool` invocation is `zendesk_status`:

```ts
    const result = await client.callTool({
      name: "zendesk_status",
      arguments: {},
```

No write tool is ever executed against a mock server. That is exactly why the suite is green while **M4** (`tags: []` silently clearing every tag) is live — nothing exercises the write path's behaviour.

**Disposition: merged in PR #71** (`ecb704e`) — the new test `"the write tools send the request bodies Zendesk expects"` asserts real URLs, methods and request bodies, and pins that an omitted `public` stays `false`. Filed as issue **#47**.

### M13 — Medium — Release version drift: version says 0.6.1, but only `v0.6.0` is tagged

**Confirmed (re-verified by me).** `git tag --list` returns `v0.6.0` as the only tag, while both `plugins/zendesk-connector/package.json` and `plugins/zendesk-connector/.codex-plugin/plugin.json` declare `"version": "0.6.1"`.

**Impact.** The tree is one release ahead of the last tag with no tag and no release for it. The bug report template asks contributors for `0.6.0`, so a bug filed against the current build is labelled with a stale version.

**Remediation.** Tag and release `v0.6.1`, and point the issue template at the version the reporter is actually running.

**Disposition: open — owner action (tag and publish).** Filed as issue **#48**.

### M14 — Low — `npm audit --audit-level=high` hides a live moderate advisory in the production tree

**Confirmed (re-verified by me).**

```
@hono/node-server  1.19.10 - 2.1.2
Severity: moderate
@hono/node-server: `serveStatic` decodes the request path a second time, leading to bypass of middleware on static paths
  https://github.com/advisories/GHSA-rmxm-3fg6-px4f
```

`npm ls @hono/node-server` shows `2.1.1`, pulled in transitively:

```
@abd-enterprises/zendesk-mcp@0.6.1
└─┬ @modelcontextprotocol/sdk@1.32.2
  └── @hono/node-server@2.1.1
```

CI's audit step gates at `--audit-level=high`, so a moderate advisory passes **silently** — the job stays green and nothing is reported.

**Impact is limited:** the connector uses the stdio transport, not `serveStatic`, so the vulnerable path is not exercised. The gap is that the gate is blind to moderate findings.

**Remediation.** Report moderates (`--audit-level=moderate`) or use `npm audit --omit=dev` with an explicit allowlist, so an advisory is a visible signal rather than a silent one.

**Disposition: merged in PR #76.** Filed as issue **#49**.

---

## 7. Findings from my review of PR #71

I reviewed PR #71 (`fix/s0-runtime-token-leak`) as the fresh-context reviewer required by `AGENTS.md:17`, against its exact head. Two findings, both **reproduced by me** against the built artefact rather than inferred from the diff.

### P1 — High — The retained `error` value was gated by a *shape* check, not the fixed vocabulary the comment claimed *(FIXED at `ecb704e`)*

**Confirmed by reproduction at head `1111f743e3b2a7ec499c72961e168134bf8afc0b`.**

PR #71 replaced the raw body in `auth.ts` with a shape summary — media type, byte count, field names, and the OAuth `error` code. That was the right design and a large improvement over `main`. But the retained `error` **value** was gated by:

```ts
      const code = record.error;
      if (typeof code === "string" && /^[a-z][a-z0-9_]{0,31}$/.test(code)) {
        summary.error = code;
      }
```

…while the comment asserted a different guarantee:

> The OAuth error code is a fixed, lowercase vocabulary, so it is safe to keep and it is what tells an agent why the exchange was refused.

A shape check is not a vocabulary check. A **lowercase credential looks like a lowercase word**, so it passes. Reproduced against the built artefact:

| token-endpoint body | `details` at `1111f74` | leak |
|---|---|---|
| `{"error":"sk_example_abc123"}` | `{"mediaType":"application/json","bytes":26,"keys":["error"],"error":"sk_example_abc123"}` | **yes** |
| `{"error":"abcdefghijklmnopqrstuvwx"}` | `{... "error":"abcdefghijklmnopqrstuvwx"}` | **yes** |
| `{"error":"invalid_client"}` | `{... "error":"invalid_client"}` | no (legitimate) |

**Why this mattered.** The PR's title claims *"keep token-endpoint values out of the runtime auth error"* — and `error` **is** a token-endpoint value, and the one field the change deliberately kept. The invariant the PR stated was not met by the PR itself, and the comment asserted a guarantee the code did not enforce. This is the same class as S0: a value-shaped secret reaching the agent's context.

**Remediation applied** (by the PR author, at `c46ef87`; merged as `ecb704e`) — the vocabulary check the comment always claimed:

```ts
const OAUTH_ERROR_CODES = new Set([
  "invalid_request", "invalid_client", "invalid_grant",
  "unauthorized_client", "unsupported_grant_type", "invalid_scope",
  "access_denied",   // OpenID Connect
]);
```

`access_denied` was added beyond RFC 6749 §5.2 because it is a code an agent can legitimately see in this flow.

**Disposition: merged in PR #71.** Re-running my probe against the new head: both leak cases now return `contains secret: false`, and `invalid_client` is still preserved. Covered by issue **#31**; the change is in PR #71.

### P2 — Medium — The field-name rule missed adjacent credential shapes *(FIXED at `ecb704e`)*

**Confirmed by reproduction at head `1111f74`.** The rule for keeping a field *name* was:

```ts
function safeFieldName(name: string): string {
  return /^[a-z][a-z0-9_]{0,63}$/.test(name) && !/\d{3,}/.test(name)
    ? name
    : "[REDACTED]";
}
```

`!\d{3,}` masks a name only when it contains **three or more** consecutive digits. Reproduced:

| token-endpoint body | `details.keys` at `1111f74` | leak |
|---|---|---|
| `{"sk_example_invented999":"x"}` | `["[REDACTED]"]` | no |
| `{"sk_example_abc12":"x"}` | `["sk_example_abc12"]` | **yes** — only 2 digits |
| `{"abcdefghijklmnopqrstuvwx":"x"}` | `["abcdefghijklmnopqrstuvwx"]` | **yes** — no digits |

The heuristic caught the one shape that had been demonstrated and missed its neighbours. A secret in the **name** position is a more exotic threat than one in a value position, so this was P2, not P1 — but `\d{3,}` was the wrong tool.

**Remediation applied** (at `c46ef87`; merged as `ecb704e`) — the same allowlist device as P1, applied twice rather than two heuristics to keep in sync:

```ts
const TOKEN_RESPONSE_FIELDS = new Set([
  "access_token", "token_type", "expires_in", "refresh_token", "scope",
  "id_token", "error", "error_description", "error_uri", "code", "client_id",
]);
```

**Disposition: merged in PR #71.** All three name cases now return `["[REDACTED]"]`.

### Review verdict on PR #71 at `c46ef87`

`c46ef87` and `1111f74` are PR #71's own commits. The pull request was squash-merged, so `main`
carries the merge commit `ecb704e` and neither branch commit; the two are named here because they
are the revisions the review was run against.

**Approved.** Verified in an isolated checkout at the exact SHA:

- `npm run check` green — typecheck clean, **181 tests, 0 failures** (171 on `main`, 178 at `1111f74`, 181 at `c46ef87`).
- Both leak classes closed by my own probe, re-run against the new head.
- The legitimate `invalid_client` code and the legitimate field names are still preserved — the fix is not over-broad.
- `redact()` and its key-name contract untouched, so `audit.test.ts`'s pinned behaviour and PR #29's import remain intact.
- Only one token-fetch site exists (`auth.ts:413`), so no other raw-body path survives in the OAuth flow.
- No consumer depends on `ZendeskAuthError.details` holding the raw payload — `server.ts:521` is the only reader — so there is no regression surface.
- Edge cases handled: non-object body, empty body, JSON array, `null` body, and hostile `Content-Type` values (`narrowMediaType` constrains to a bounded `type/subtype`, else `"unknown"`).
- Output is bounded: ≤32 field names, `error` code ≤32 chars, `mediaType` ≤64 chars per component.
- Scope respected: `audit.ts`, `oauth-setup.ts` and the other sinks untouched; `tags: []` (M4) deliberately left unasserted so **#45** stays open.

---

## 8. Complete finding index and disposition

44 findings. **Issue** is the GitHub issue filed for it (all 41 filed, `#30`–`#70`).

| ID | Sev | Area | Title | Location | Issue | Disposition |
|---|---|---|---|---|---|---|
| S0 | **High** | Security | Runtime token-exchange failure hands the raw body to the agent | `auth.ts:421-437` | #31 | **Merged** — PR #71 |
| S1 | **High** | Security | Token-exchange failure prints the raw access token to stderr | `oauth-setup.ts:597-601` | #30 | **Merged** — PR #29 |
| S2 | Med | Security | Token-file write follows a pre-planted symlink | `auth.ts:593-605` | #32 | **Merged** — PR #73 |
| S3 | Med | Security | Console has no Host/origin validation (DNS rebinding) | `server.mjs:350` | #33 | **Merged** — PR #75 |
| S4 | Med | Security | `redact()` matches key names only; strings never scrubbed | `audit.ts:127-138` | #34 | **Merged** — PR #73 |
| S5 | Low | Security | Tool-call audit path skips `redact()` | `audit.ts:81` | #35 | **Merged** — PR #73 |
| S6 | Low | Security | Console mints a `read write` scope for a read-only app | `server.mjs:170` | #36 | **Merged** — PR #75 |
| S7 | Low | Security | Console performs no base-URL validation | `server.mjs:162` | #37 | **Merged** — PR #75 |
| S8 | Low | Security | Raw error messages returned to the browser | `server.mjs:295-300` | #38 | **Merged** — PR #75 |
| S9 | Low | Security | `/api/*` not rate-limited *(deliberate)* | `server.mjs:253,262` | #39 | **Merged** — PR #78 |
| S10 | Low | Security | No PKCE *(acknowledged in the docs)* | `oauth-setup.ts:463-475` | — | Closed by decision |
| S11 | Low | Security | `zendesk_status` discloses the token-file path | `auth.ts:370-378` | #41 | **Merged** — PR #73 |
| S12 | Info | Security | CI falls back to self-hosted runners if the guard var is deleted | `ci.yml` | #40 | **Merged** — PR #76 |
| M1 | Med | Maint | The tool list is written out by hand in twelve files | `docs/`, `README.md` | #42 | Open — deferred refactor |
| M2 | Med | Maint | `safeJson` triplicated; `errorMessage` + mode predicates duplicated | `auth.ts:631` etc. | #43 | Open — deferred refactor |
| M3 | Med | Maint | `destructiveHint: false` hardcoded for all three write tools | `server.ts:467-474` | #44 | **Merged** — PR #74 |
| M4 | Med | Maint | `tags: []` silently clears every tag on a ticket | `server.ts:199,501` | #45 | **Merged** — PR #74 |
| M5 | Med | Maint | `npm run e2e:mock` never runs in CI | `ci.yml:43` | #46 | **Merged** — PR #76 |
| M6 | Low | Maint | Unsound generic cast on unvalidated JSON | `client.ts:110` | #50 | Open — deferred refactor |
| M7 | Low | Maint | Global `fetch` bypasses the injectable fetcher | `oauth-setup.ts:578` | #51 | Open — deferred refactor |
| M8 | Low | Maint | 4 env-access styles, 4 validation policies | `auth.ts`, `policy.ts`, `client.ts` | #52 | Open — deferred refactor |
| M9 | Low | Maint | `.env.example` documents 8 of ~16 `ZENDESK_*` vars | `.env.example` | #53 | **Merged** — PR #78 |
| M10 | Low | Maint | Console duplicates domain constants server↔frontend | `server.mjs:46` | #54 | **Merged** — PR #79 |
| M11 | Low | Maint | `server.ts` concentrates 12 tool definitions in one function | `server.ts` | #55 | Open — deferred refactor |
| M12 | Med | Maint | The three write tools are never invoked by any test | `server.test.ts:147` | #47 | **Merged** — PR #71 |
| M13 | Med | Maint | Version drift: `0.6.1` vs only `v0.6.0` tagged | `package.json` | #48 | Open — owner action (tag and publish) |
| M14 | Low | Maint | Audit gate hides a live moderate advisory | `@hono/node-server@2.1.1` | #49 | **Merged** — PR #76 |
| U1 | **High** | Usability | `commentUsers` is always `undefined` | `server.ts:136` vs `:141` | #56 | **Merged** — PR #74 |
| U2 | Med | Usability | Search mislabels non-ticket results as tickets | `server.ts:94-100` | #57 | **Merged** — PR #74 |
| U3 | Med | Usability | Truncated comments have no continuation path | `server.ts:136,142` | #58 | **Merged** — PR #74 |
| U4 | Med | Usability | Console `load()` has no `catch` → silent empty dashboard | `App.tsx:210-217` | #59 | **Merged** — PR #80 |
| U5 | Med | Usability | Search description omits pagination, shape, id handoff | `server.ts:61-74` | #60 | **Merged** — PR #74 |
| U6 | Med | Usability | Write-tool descriptions are 5 words; params undescribed | `server.ts:152,184,214` | #61 | **Merged** — PR #74 |
| U7 | Med | Usability | No `--help`; unknown flags start the server and hang | `index.ts:14-47` | #62 | **Merged** — PR #77 |
| U8 | Med | Usability | Doctor can't detect scope/expiry; never prints enabled tools | `doctor.ts:71-114` | #63 | **Merged** — PR #77 |
| U9 | Med | Usability | Console requires 7 config IDs, needs 5 for data | `server.mjs:48-56` | #64 | **Merged** — PR #79 |
| U10 | Med | Usability | Two shipped surfaces disagree on which comments return | `server.ts:110` vs `tool-contracts.md:104` | #65 | **Merged** — PR #74 |
| U11 | Low | Usability | No `logout` / `healthcheck` npm script | `package.json` | #66 | **Merged** — PR #78 |
| U12 | Low | Usability | Manifest uses a relative path for the entrypoint | `.mcp.json:6` | #67 | **Merged** — PR #78 (documentation) |
| U13 | Low | Usability | Console workstream statuses are hard-coded literals | `App.tsx:96-104` | #68 | **Merged** — PR #80 |
| U14 | Low | Usability | Two headline metrics measured inconsistently | `server.mjs:280-281` | #69 | **Merged** — PR #79 |
| U15 | Low | Usability | `Math.max(0, ...array)` risks a stack overflow | `server.mjs:283` | #70 | **Merged** — PR #79 |
| **P1** | **High** | Security | Retained `error` value gated by shape, not vocabulary | `auth.ts:661-666` @ `1111f74` | #31 | **Merged** — PR #71 |
| **P2** | Med | Security | Field-name rule missed adjacent credential shapes | `auth.ts:680-684` @ `1111f74` | #31 | **Merged** — PR #71 |

**Roll-up:** 4 High, 20 Medium, 19 Low, 1 Info = **44**.
**Closed or fixed:** 36 findings, each merged in one of PR #29, #71, #73, #74, #75, #76, #77, #78, #79 and #80; S10 closed by decision. **Open: 7** — M1, M2, M6, M7, M8, M11, M13 — each with a filed issue.

### What is still live on `main`

The security and correctness findings of this review are all merged. 7 findings are still open, and each has a filed issue:

| ID | Issue | What is left |
|---|---|---|
| M1 | #42 | The tool list is written out by hand in twelve files, and this artifact is a thirteenth. |
| M2 | #43 | `safeJson`, `errorMessage` and the mode predicates are duplicated. |
| M6 | #50 | The client casts an unvalidated response to the caller's type. |
| M7 | #51 | The token exchange calls the global `fetch` instead of an injected one. |
| M8 | #52 | Four ways to read an environment variable, four policies for an unknown value. |
| M11 | #55 | `server.ts` holds the twelve tool definitions in one function. |
| M13 | #48 | The version in `package.json` is ahead of the tag; the tag and the publish are the owner's to make. |

---

## 9. Checked and found sound

Recorded so the next reviewer does not repeat this work.

**Security.** OAuth `state` is 24 bytes of `randomBytes`, hex-encoded and validated on callback. The local callback server binds `127.0.0.1` only. The `authorization_code` flow is a confidential client (sends `client_secret`), which is why PKCE is correctly documented as N/A. The client-file permission check (`mode & 0o077`) is enforced on read. `ZENDESK_READ_ONLY` and `ZENDESK_ALLOWED_TOOLS` gate **every** tool through `allowedTools.has(...) && server.registerTool(...)` plus a runtime `guard()` call — there is no path that reaches a write tool without passing the allowlist. 401-refresh is single-shot and bounded; 429 backoff is capped. `redact()` correctly masks nested token keys inside `ZendeskError.details.response`. Tokens are written with mode `0o600` and the token directory is created `0o700`.

**CI/CD.** OIDC-based npm publish rather than a long-lived token. Node 20/22/24 matrix. Production dependency audit. Docker build is multi-stage, runs as the non-root `node` user, and has a healthcheck (`Dockerfile:10-18`). The `npm-publish.yml` workflow correctly separates trusted publish events from pull-request runs.

**Testing.** 171 tests pass with zero failures; typecheck is clean. The suite uses in-memory MCP transports and mock HTTP, never a live account. Policy enforcement, rate-limit backoff, redaction, pagination and the OAuth error paths all have coverage. The `rate-limit.test.mjs:368` assertion documents the deliberate rate-limiter scoping.

**Docs.** `docs/tool-contracts.md` is thorough and largely accurate — its error-envelope and redaction description matches the code. `README.md`'s Quickstart is copy-pasteable with the Node prerequisite stated and the Admin Center location and exact callback URL named. `doctor`'s messages consistently name a command or a variable to set.

**Code hygiene.** No dead exports found; `toolNames` and the other shared constants are consumed by the tests. No `TODO`/`FIXME`/`HACK` markers in the connector source. The `zendesk_status` server-level `instructions` string (`server.ts:20-21`) is good guidance. `.gitignore` correctly excludes `.env*` with an explicit `!.env.example` exception.

---

## 10. Not verified — caveats

- **The DNS-rebinding exploit (S3) was not executed.** The finding rests on the confirmed absence of any `Host` or `Origin` check in `server.mjs`.
- **Node's exact `JSON.parse` error text (S8)** was probed on Node v26 only; the V8 message format may differ slightly on Node 20 (the connector's floor).
- **The console's server-side tests were not run locally** — `apps/operations-console/node_modules` was absent. They **do** run in CI (`ci.yml:164`: `npm ci`, typecheck, build, `npm test`), so this is an environment limitation, not a project gap.
- **No live Zendesk account was exercised.** U2's cross-entity behaviour is verified against Zendesk's published API documentation, not against a live search response.
- **The maintainability sweep (section 4) is single-prior.** The reviewer subagent assigned to it over-ran and was cancelled; that section was completed by the primary reviewer under the same verification standard, but it is the only section without independent second-reviewer corroboration.
- **Severity ratings are the reviewer's judgement**, informed by the exploitability reasoning recorded per finding. They are a starting point for triage, not a substitute for the owner's risk assessment.
- **The PR #71 findings (P1, P2) were verified by execution, not by reading.** I built the artefact at both `1111f74` and `c46ef87` in a throwaway checkout and ran an adversarial probe against it. That checkout has been removed; the shared repo was never written to. The probe script (`s0-review-probe.mjs`) was a temporary artifact outside the repo, and it is the only surviving file from that review.
- **P1 and P2 are recorded here as findings in their own right even though they were found in a review of a fix, not in the original audit.** They are not "new bugs" — they were latent in the original design (`details` carrying a raw body) and were only *exposed* by the shape summary's attempt to keep the `error` code. Reading them as regressions against `main` would be wrong: `main` was strictly worse.
- **The DNS-rebinding exploit (S3) was not executed.** The finding rests on the confirmed absence of any `Host` or `Origin` check in `server.mjs`.
- **Node's exact `JSON.parse` error text (S8)** was probed on Node v26 only; the V8 message format may differ on Node 20 (the connector's floor).
- **The console's server-side tests were not run locally** — `apps/operations-console/node_modules` was absent. They **do** run in CI (`ci.yml:164`).
- **No live Zendesk account was exercised.** U2's cross-entity behaviour is verified against Zendesk's published API documentation, not against a live search response.
- **The maintainability sweep (§4) is single-prior.** The reviewer subagent assigned to it over-ran and was cancelled; that section was completed by the primary reviewer under the same verification standard. The parallel agent's four additional findings are recorded in §6 because I re-verified each one against source myself rather than on its word.

---

## 11. Suggested issue titles

**These have been filed** as GitHub issues `#30`–`#70`. The titles below are the original wording from this review; §8 maps each finding to its issue number.

**Security**
1. `fix: redact the token-exchange error body` *(already open as PR #29 — verify it is merged)*
2. `fix: write the OAuth token file with the exclusive flag`
3. `fix: validate the Host header in the operations console`
4. `fix: scrub credential-shaped substrings inside strings in redact()`
5. `fix: route the tool-call audit event through redact()`
6. `fix: request read-only OAuth scopes in the operations console`
7. `fix: validate the console base URL and require HTTPS`
8. `fix: return a fixed error message to the console browser`
9. `docs: record the deliberate rate-limiter scoping for /api routes`
10. `fix: fail CI when LINUX_RUNNER_LABELS is unset instead of using self-hosted runners`
11. `fix: omit the token file path from the zendesk_status payload`

**Maintainability**
12. `refactor: generate the tool tables from a single source of truth`
13. `refactor: extract the duplicated safeJson, errorMessage and mode-predicate helpers`
14. `fix: set destructiveHint correctly on the write tools`
15. `fix: treat an empty tags array as no change in zendesk_update_ticket`
16. `ci: run the hermetic mock e2e suite`
17. `refactor: validate API responses at the client boundary`
18. `refactor: inject the fetcher into the OAuth token exchange`
19. `refactor: unify environment-variable access and validation`
20. `docs: list every supported ZENDESK_ variable in .env.example`
21. `refactor: share domain constants between the console server and frontend`
22. `refactor: split the tool definitions out of server.ts`

**Usability**
23. `fix: request include=users on the ticket comments side-load`
24. `fix: label search results with result_type or force type:ticket`
25. `fix: support comment pagination in zendesk_get_ticket`
26. `fix: handle fetch failures in the operations console`
27. `docs: describe pagination, result shape and the ticket-id handoff in tool descriptions`
28. `docs: expand the write-tool descriptions`
29. `feat: add --help and reject unknown flags`
30. `feat: let the doctor print the enabled tool set and effective scope`
31. `fix: require only the console ids needed for data`
32. `docs: correct the "recent comments" description`
33. `feat: add logout and healthcheck npm scripts`
34. `fix: use an absolute server path in .mcp.json`
35. `docs: label the console workstream statuses as illustrative`
36. `fix: measure the console metrics consistently`
37. `fix: avoid spreading a ticket array into Math.max`
