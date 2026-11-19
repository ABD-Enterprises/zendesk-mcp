# SureForgeTech fleet — session run record

Operator-local record of this session's work. Not part of any repository.

## What landed

Every pull request that was open in the three repositories this session touched is merged.
All three `main` branches are green on every check.

| Repository | Merged this session | `main` head |
| --- | --- | --- |
| `SureForgeTech/sureforge-zendesk` | #132 (CRLF sign-off fix), #123 (trigger-tool docs), #134 (manifest-preflight EPIPE flake), #133 (DCO sign-off self-test), #135 (the five new read features), #136 (gh configuration hardening) | `60682ff4` |
| `SureForgeTech/sureforge-cfr` | #258 (one title per scope), #261 (harden access control, rate limiting and output escaping) | `5b05c121` |
| `SureForgeTech/sureforge-jira-mcp` | #5 (keep the listing honest about what it does not know) | `6a42fe91` |

## The five new read features (sureforge-zendesk #135)

The connector went from 23 tools (20 read) to 31 (28 read):

1. `zendesk_list_ticket_audits` — the ticket's history.
2. `zendesk_list_ticket_attachments` — the files a customer sent, read off the ticket's comments.
3. `zendesk_list_organization_users` and `zendesk_list_user_organizations` — the relationship from both sides.
4. `zendesk_list_group_users` and `zendesk_list_group_memberships` — who belongs to a group.
5. `zendesk_list_macros` and `zendesk_get_macro` — the prepared answers an agent applies.

## Review record

Every merged head carried one independent, fresh-context review of the exact head. The reviewers
were GLM-5.3-Flash on the OpenCode Go tier, MiniMax M3.1 Flash, and Kimi K3.1 Pro. The review
records are on the pull requests; the substantive findings and their fixes:

- **sureforge-zendesk #133** — the self-test let an inherited `GH_ENTERPRISE_TOKEN` reach the
  mock server, and later the CLI's own stored configuration. Both are closed, each with a test
  that fails without the fix. The finding about the stored configuration was raised after #133
  merged and closed in #136.
- **sureforge-cfr #261** — three rounds. The first head declared a runtime floor (Node 22.15)
  that could not run the product at all: that release bundles `node:sqlite` without FTS5, and
  the index schema is an FTS5 table. The floor is now Node 22.16, verified by running the suite
  under both releases. Also fixed: an unbounded reference-definition lookahead, the
  angle-bracket rule, the read path escaping pre-rule rows, a symlinked index path that never
  got its permissions tightened, and the trusted-proxy requirement the spec did not state.
- **sureforge-jira-mcp #5** — one P1 (a single flag for two different unknowns, which
  downgraded a genuinely missing parent from high severity and claimed a complete listing was
  incomplete), one P2 (the same guard, narrowed), and a P2 about a field holding free text
  becoming an epic relation. All closed with tests.

## Provider availability, measured

- Kimi `k3.1-pro`: quota exhausted ("5-hour usage limit"). `k3.1-pro-highspeed` and
  `kimi-for-coding` answer a probe, but a full review exhausted the quota again.
- OpenCode free tier (`-free` models): "Free usage limit reached".
- OpenCode Go (`opencode-go/glm-5.3-flash`): available throughout, and carried the reviews of
  the cfr and zendesk pull requests.
- `minimax-coding-plan/MiniMax-M3.1-Flash`: available, and carried the reviews of the jira pull
  request.

## Two things the owner had to do

- The **org ruleset** `required_approving_review_count` was lowered from 1 to 0 part-way
  through. Until then, every merge was blocked by "an approval you cannot give yourself",
  because the only identity in this sandbox is the `abd-oss-lane[bot]` app that authored the
  pull requests. The `abd-oss-lane-reviewer[bot]` app exists (id 5807306, `pull_requests:
  write`, no webhook events) but has no credential here and cannot be requested as a reviewer
  through the API.
- The GitHub token was rotated twice mid-session and was briefly invalid.

## Worktrees and mirrors

- `/workspace/sureforge-zendesk` — `fix/dco-signoff-config-dir` (merged as #136)
- `/workspace/zendesk-flake-fix` — `test/manifest-preflight-epipe` (merged as #134)
- `/workspace/zendesk-features` — `feat/read-coverage` (merged as #135)
- `/workspace/zendesk-mcp` — the shared clone of the zendesk repository; another session's
  checkout of `fix/trigger-docs-followup` (merged as #123), left untouched
- `/tmp/opencode/zendesk-next/` — the cfr and jira review mirrors, the staged merge payloads
  and the verification scripts
- `/workspace/zendesk-session-record.md` — this file

All three of this session's worktrees sit on merged branches, are clean, and are in step with
their remotes. The shared clone and the other sessions' worktrees were not modified.
