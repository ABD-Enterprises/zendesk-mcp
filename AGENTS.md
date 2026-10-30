# Agent instructions: zendesk-mcp

<!-- fleet-core:begin (generated: edit the fleet source, not this block) -->
## Fleet core

Applies to every repository in the fleet. It is generated from one source; repository-specific rules go outside the markers.

### Evidence
- Read live state before stating it: fetch the remote, read the default branch, run the command. A number or an "X is missing" taken from a doc or a stale checkout is a claim to verify. A figure in a doc carries its date and how it was read.
- Find the root cause before proposing a remedy. For an unreachable or hung host, check its network interface and the previous boot's log before blaming memory.
- Give one account of a fact. If two places disagree, fix or flag one.
- Say plainly what you did not verify.

### Changes
- One bounded task per change request. Stay in scope: no drive-by edits and no agent scratch files committed.
- Run the repository's validation (named below) before pushing.
- A change request merges when a fresh-context review of the exact head has no unresolved P0 or P1 findings and every required check is green. A new commit needs a new review; a clean automatic merge of the base branch keeps the review.
- At most three open non-draft change requests per repository. While the fleet backlog check reports a backlog, finish and land existing work and start nothing new.
- Fix a finding that takes minutes in the current change; fold the rest into an existing tracking issue. A session closes at least as many issues as it opens on its own initiative; tickets the owner asks for in chat are separate.

### Safety
- Never print, log or commit tokens, passwords or keys. Use the credential helper the repository names.
- One writer per checkout: separate worktrees for separate writers. Do not force-push, rebase or delete a branch another session may own.
- Private repositories run CI on self-hosted runners only. A job that must not share a host (for example signing) runs on a dedicated self-hosted runner group, never on a GitHub-hosted runner without the owner's approval.
- Ask the owner only for a step no agent can do or for a spend or legal commitment; decide and record everything else.

### Layout
- AGENTS.md is the canonical agent file; where a CLAUDE.md exists it only imports it. Keep this file under 200 lines.
- Name this repository's validation command, merge rule and changelog rule outside the markers. Rules kept outside the repository are not visible here: if a task seems to need one, ask rather than guess.
- Shared skills are installed per machine from the fleet skills hub. Name the ones this repository expects below.

### Forge: GitHub
- Prefer REST (`gh api repos/OWNER/REPO/...`) to GraphQL for single reads: the rate-limit pools are shared by every session on the account.
- Required checks and review rules are branch protection or rulesets; read them with `gh api`. Review-thread resolution needs GraphQL.
<!-- fleet-core:end -->

## Repository-specific

- Public repository: every file here, and anything an agent writes into it (code, comments, commit messages, pull request text, test fixtures), is world-readable. Use only invented values (`example`-style names, fake ids) in code, tests and docs.
- This repository starts from a clean snapshot: no tracked file holds live-account data, and earlier private commits are not in its history. Never add real tenant, customer or ticket data anywhere — not in code, tests, docs, `.env` examples, commit messages, issue or pull-request text, or chat output — and if a change seems to need some, ask instead. The connector (`plugins/zendesk-connector/`) is generic and its tests use mock HTTP.
- What it is: an OAuth-only MCP server for Zendesk Support (TypeScript on Node 20 or newer, MIT) in `plugins/zendesk-connector/`, a Codex plugin definition (`.agents/plugins/marketplace.json`, `plugins/zendesk-connector/.codex-plugin/plugin.json`, `.mcp.json`), and a local web console in `apps/operations-console/` (a separate app, `npm run dev` there).
- Layout: server and tests in `plugins/zendesk-connector/src/` (`server.ts` tools, `auth.ts` OAuth, `client.ts` HTTP, `policy.ts` tool allowlist, `audit.ts` logging; tests sit beside them as `*.test.ts`), `docs/` (roadmap and release checklist), the repository root `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`.
- Validation: from `plugins/zendesk-connector`, run `npm ci`, `npm run check` (type check, build and tests using mock HTTP and in-memory MCP transports), and `npm pack --dry-run`. The CI workflow exercises Node 20, 22 and 24, audits production dependencies, checks plugin files, and builds the Docker image. Its Node 22 console job runs `npm ci`, typecheck, build, tests and the production audit. The console tests use a local mock Zendesk server.
- Merge: the fleet core's merge rule applies. Read the live rulesets and required checks before merging, and wait for CI and an independent exact-head review. Public pull-request jobs use GitHub-hosted runners: retain the repository variable `LINUX_RUNNER_LABELS` as `["ubuntu-latest"]`. `ci.yml` falls back to self-hosted labels if that variable is deleted, which would put public pull-request code on operator hardware; do not delete or change it.
- Changelog: `CHANGELOG.md` starts with `## Unreleased`, then one section per prepared version (latest `0.6.1`), and it is updated when a release is prepared (`docs/release-checklist.md`), so an ordinary change adds no entry. The `## Unreleased` section records the changes the tool-contract versioning policy requires to be called out — a change that breaks a documented contract is called out there and in the root README before it ships. CI checks only the structure (`scripts/check-changelog.mjs`: exactly one `Unreleased` section and it is first, version sections are semver, newest first, none empty). The version has one source: the `version` field in `plugins/zendesk-connector/package.json` (currently `0.6.1`). `src/version.ts` reads it at startup and feeds the MCP server info and the HTTP User-Agent; a test asserts that `.codex-plugin/plugin.json` carries the same version. The changelog still names the version when a release is prepared.
- Live Zendesk: the twelve tools act on whatever Zendesk account the configured credentials reach. Read tools: `zendesk_status`, `zendesk_search_tickets`, `zendesk_get_ticket`, `zendesk_list_brands`, `zendesk_list_groups`, `zendesk_list_users`, `zendesk_list_organizations`, `zendesk_list_ticket_fields`, `zendesk_list_ticket_forms`. Write tools: `zendesk_create_ticket`, `zendesk_update_ticket` and `zendesk_add_ticket_comment` (internal note by default, public reply possible). `zendesk_create_ticket` sends its first comment publicly unless `public: false` is passed. There is no delete tool. Run the server, `npm run oauth:setup` or any tool against a live account only when the owner asks, read-only tools first, and use a sandbox or test account for write tools (the README and release checklist say the same). To limit an agent session to reading, set `ZENDESK_READ_ONLY=1` (or set `ZENDESK_ALLOWED_TOOLS` to the nine read tool names) (`plugins/zendesk-connector/src/policy.ts`). MCP tool annotations are hints, not access control.
- Credentials: OAuth only; never add API-token or password flows (CONTRIBUTING.md). Supplied by environment variables (`ZENDESK_SUBDOMAIN`, `ZENDESK_OAUTH_CLIENT_ID`, `ZENDESK_OAUTH_CLIENT_SECRET`, or `ZENDESK_OAUTH_ACCESS_TOKEN` in access-token mode) or by an owner-only file, default `~/.config/codex-zendesk/client.json`; environment variables win over the file. Tokens are stored in `~/.config/codex-zendesk/oauth.json`. Never read, print, copy or commit those files or values. To check what is set use `env | cut -d= -f1 | grep ZENDESK`. `.env*` files are git-ignored except `.env.example`.
- Operations console: `apps/operations-console/server.mjs` reads the same client file and makes live read requests (plus an OAuth token request) against the account it points to, and serves on `127.0.0.1:4177`. It is a reference app: the account identifiers it needs (brand, ticket fields, view ids) come from `ZENDESK_CONSOLE_*` environment variables, documented in `apps/operations-console/.env.example`, and no live-account data is kept in the tree. Do not start it unless the owner asks, and do not add hard-coded identifiers.
- Install-time: no postinstall or prepare hooks; `prepack` builds the package. `Dockerfile` (in the connector directory) builds only; `ci.yml` builds it on pull requests and pushes but never publishes anything — only `release.yml` pushes the image (to GHCR) when a version tag is pushed.
- Skills: this repository expects no hub skills.
