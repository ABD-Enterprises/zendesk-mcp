# Release Records

This file records, for each released version, the release commit, the tag and
its object, the published GitHub release, and the published container image
digest. It is the release record referenced by
[release-checklist.md](release-checklist.md), and it is updated when a
release is prepared or when an artifact moves (see Rollback in the
checklist). One section per released version, newest first.

## 0.6.0

- Release commit: `146fcb9f118fdcb2f29c9f8f51f630d22903cd1f` — the commit
  `v0.6.0` points to, and `main` at release time.
- Tag: `v0.6.0`, an annotated tag object
  `d0456d9430d02b4b7d15caa1325ad2f57231c4fe` resolving to that commit.
- GitHub release: published 2026-10-27T00:42:50Z.
- Container image: `ghcr.io/abd-enterprises/zendesk-mcp:0.6.0`, digest
  `ghcr.io/abd-enterprises/zendesk-mcp@sha256:c879960c79004b20365b544a0ed256e9e2360551bb463061ae2af5e9a8ea9091`,
  pushed by the release workflow for the tag.
- npm package: `@abd-enterprises/zendesk-mcp` version 0.6.0 was never
  published — the tag predates the automated OIDC npm publish path (added
  for 0.6.1), and its release run predates the `publish-npm` job, so there
  is no npm artifact and no publish date to record. Automated npm publishing
  starts with 0.6.1; the registry has no 0.6.0 to deprecate or unpublish.
