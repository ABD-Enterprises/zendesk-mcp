# Changelog notes

Give each change its own file so concurrent pull requests can add entries
without editing the same section of `CHANGELOG.md`. Name it
`changelog.d/<issue-or-slug>.md` and write one or more tagged entries.

```markdown
- [Changed] What changed and why it matters (#123)
  An indented line continues the entry above it.
```

Use one of the Keep a Changelog sections `Added`, `Changed`, `Deprecated`,
`Removed`, `Fixed`, or `Security`. The PR number is optional.

Run `python3 scripts/changelog.py check` to validate notes. Pull request CI
runs the check with `--base HEAD^1` and rejects direct additions under
`## Unreleased` in `CHANGELOG.md`.

In the release PR, run `python3 scripts/changelog.py assemble` to fold the
notes into their sections under `## Unreleased` and delete the folded files.
Only notes already on the base branch count as folded in the CI check.
