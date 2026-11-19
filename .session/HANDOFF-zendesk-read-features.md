# HANDOFF — zendesk-read-features

Session handoff for the SureForgeTech fleet work. Written 2026-11-19; nothing is in flight.

## Goal

Build the next five most valuable read features for the `SureForgeTech/sureforge-zendesk`
connector — tested, committed, pushed, independently reviewed and merged — and land the pull
requests that were already outstanding across the three repositories this session touched.

## What is done, and whether it is tested

Everything is merged. Zero open pull requests in `sureforge-zendesk`, `sureforge-cfr` and
`sureforge-jira-mcp`; every `main` is green on every check.

| Repository | `main` | Landed this session |
| --- | --- | --- |
| `sureforge-zendesk` | `60682ff4` | #132, #123, #134, #133, **#135** (the five features), #136 |
| `sureforge-cfr` | `5b05c121` | #258, #261 |
| `sureforge-jira-mcp` | `6a42fe91` | #5 |

The five features (PR #135, eight commits, +2071/-19) take the connector from 23 tools
(20 read) to 31 (28 read): `zendesk_list_ticket_audits`, `zendesk_list_ticket_attachments`,
`zendesk_list_organization_users` + `zendesk_list_user_organizations`,
`zendesk_list_group_users` + `zendesk_list_group_memberships`, `zendesk_list_macros` +
`zendesk_get_macro`.

Tested, and the tests are load-bearing:

- `npm run ci` exits 0 at every merged head (format, lint, actionlint, typecheck, coverage,
  build, audit). The zendesk connector: `npm run check` 387 tests (383 pass, 0 fail, 4 skipped),
  `npm run e2e:mock` 6/6, `npm pack --dry-run` 32 files. The jira repo: `npm run check` 163
  unit tests + 2 end-to-end tests, 0 failing. The tool-table drift check and the changelog check
  pass in every repository.
- Each merged head carries one independent, fresh-context review of that exact head, recorded on
  the pull request. The reviews found four defects of mine, all fixed before merge and each
  covered by a test that fails without the fix: #135 invented two Zendesk endpoints that do not
  exist and used the wrong envelope for group memberships; #261 declared a runtime floor
  (Node 22.15) whose `node:sqlite` has no FTS5, so the product could not run on it (the floor
  is now Node 22.16, verified by running the suite under both releases); #5 folded two
  different unknowns into one flag, which downgraded a genuinely missing parent from high
  severity and claimed a complete listing was incomplete; #133 let an inherited
  `GH_ENTERPRISE_TOKEN`, and later the CLI's own stored configuration, reach the test's mock
  server.

## What is half-done

Nothing in the three repositories: all worktrees are clean, all branches are in step with
their remotes, and no stashes exist. The only artefacts that live outside a repository are
this file and `/workspace/zendesk-session-record.md`; both are copied onto the pushed
`wip/zendesk-read-features` branch (under `.session/`) so a rebuild cannot lose them.

Three findings were left deliberately, each recorded on its pull request: the jira repo's
`IssueListing.truncated` documentation does not enumerate every trigger the client implements;
a duplicated rationale comment in the zendesk self-test; two commits without a sign-off
trailer (bot-authored, and the repository's DCO check exempts bots).

## Branch, commit, pull request

- Repository: `SureForgeTech/sureforge-zendesk`, cloned at `/workspace/zendesk-mcp`, with
  worktrees `/workspace/sureforge-zendesk`, `/workspace/zendesk-features` and
  `/workspace/zendesk-flake-fix`.
- This session's branches, all merged and pushed: `feat/read-coverage` (`47fc986`, PR #135),
  `test/dco-signoff-self-test` (`4a791bb`, PR #133), `test/manifest-preflight-epipe` (`eceae4c`,
  PR #134), `fix/dco-signoff-config-dir` (`754a862`, PR #136).
- Durability branch: `wip/zendesk-read-features`, branched from `origin/main` (`60682ff4`).
- Open pull requests: none.

## Decisions, and why

- **Five features in five commits on one branch rather than five branches.** The repository's
  rule allows three open pull requests at a time, and three were already waiting, so five
  branches could not have been open together. The commits stay separate and reviewable.
- **The macro tools need a scope outside the default.** `macros:read` is not in the default
  scope, so the default scope was left unchanged and the grant is documented, as the trigger
  tools already do. The other four families need no scope change.
- **Attachments are read off the ticket's comments.** Zendesk has no endpoint that lists a
  ticket's attachments, so the tool reads a page of comments and returns the attachments on
  them; the count is the number of attachments on that page and the next-page flag says whether
  the ticket has more comments.
- **The runtime floor moved to Node 22.16**, the first release whose `node:sqlite` enables
  FTS5, which the index schema needs. The `file:` URL support the immutable evidence path
  needs arrived in 22.15. A test pins both capabilities.
- **A second review was run for each changed head** rather than one review per pull request:
  the repository's rule is that a new commit needs a review of the new head.

## Blockers

None now. Two during the session, both resolved by the owner:

- *"At least 1 approving review is required by reviewers with write access."* — the org ruleset's
  `required_approving_review_count` was lowered from 1 to 0 part-way through. Before that,
  every merge was blocked, because the only identity in the sandbox is the `abd-oss-lane[bot]`
  app that authored the pull requests, and GitHub refuses an author approving their own pull
  request. The `abd-oss-lane-reviewer[bot]` app (id 5807306, `pull_requests: write`, no webhook
  events) has no credential in this sandbox and cannot be requested as a reviewer through the
  API, so it could not approve anything here.
- The GitHub token was rotated twice mid-session and was briefly invalid
  (*"Bad credentials"*), and was rewritten again at 2026-11-18 17:10 and 17:14 local time.

## Ignored or untracked files that matter

From `git status --ignored --short` in `/workspace/sureforge-zendesk` — four ignored build and
dependency directories, no untracked or modified files, no stashes:

```
!! apps/operations-console/dist/
!! apps/operations-console/node_modules/
!! plugins/zendesk-connector/dist/
!! plugins/zendesk-connector/node_modules/
```

The review mirrors for the other two repositories live in `/tmp/opencode/zendesk-next/`
(`cfr-review`, `jira-review` and the Node runtimes used to verify the runtime floor). They are
scratch: every change they carried is merged and pushed, so a rebuild loses nothing.

## Exact next step

None required for this session's work. The next piece of work is the release of
`sureforge-zendesk` (issue #48): the npm package has never been published, neither `v0.6.1`
nor `v0.7.0` was ever tagged, and `CHANGELOG.md` still carries an `## Unreleased` section.
It needs the npm trusted-publisher registration and a bootstrap publish — the owner's call.
If more agent-authored pull requests are expected, give the `abd-oss-lane-reviewer[bot]` app a
credential in the sandbox so it can approve them.
