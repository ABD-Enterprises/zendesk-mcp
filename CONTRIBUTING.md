# Contributing

## How to contribute

Issues and pull requests are both welcome. For anything larger than a small fix,
open or comment on an issue first so we agree on the approach.

Sign off every commit with `git commit -s`. This adds a `Signed-off-by:` line
certifying the [Developer Certificate of Origin](https://developercertificate.org/):
you wrote the change or have the right to submit it under the licence in this
repository's `LICENSE` file, and your contribution comes under that licence. A
check confirms the sign-off on pull requests from outside contributors. Every
pull request gets review and must pass the required checks before a maintainer
merges it.

CodeRabbit (free open-source plan) may comment on pull requests. Its reviews are advice only and never required. On repositories with fewer than 10 stars it does not run on its own; comment `@coderabbitai review` to trigger it.

- For how to write a good issue, see the
  [SureForgeTech contributing guide](https://github.com/SureForgeTech/.github/blob/main/CONTRIBUTING.md).
- Do not report security problems in a public issue; follow
  [SECURITY.md](SECURITY.md).

## For maintainers: development setup

```sh
cd plugins/zendesk-connector
npm ci
npm run check
```

Use Node.js 20 or newer. Tests must not depend on a live Zendesk account or
contain real customer data or credentials.

## For maintainers: pull requests

- Keep changes focused and explain user-visible behavior.
- Add or update tests for authentication, HTTP, or tool-contract changes.
- Preserve OAuth-only authentication; do not add API-token or password flows.
- Treat MCP tool annotations as hints, not authorization controls.
- Document new environment variables and tool permissions.
- The tool tables in `README.md`, `docs/tool-contracts.md` and
  `plugins/zendesk-connector/README.md`, and the read-only allowlist in
  `plugins/zendesk-connector/.env.example`, are generated from the tool
  policy in `plugins/zendesk-connector/src/policy.ts`. After changing the
  tool list or the write tools, run the generator from the repository root:
  `node scripts/generate-tool-tables.mjs --write`. `npm run check` fails
  when the generated sections drift away from the policy, and it runs the
  generator's own tests.
- Run `npm run check` and `npm pack --dry-run` before opening a pull request.

Ordinary changes add no changelog entry. Write an entry into the `Unreleased`
section of `CHANGELOG.md` only when a user-facing change is deliberately being
recorded: replace the placeholder line there and leave the released version
sections untouched. At release preparation, the `Unreleased` section becomes
the new version section and a fresh `Unreleased` section is started.

Use issues for feature proposals that materially expand ticket access or add
new Zendesk resources so permissions and OAuth scopes can be reviewed first.
