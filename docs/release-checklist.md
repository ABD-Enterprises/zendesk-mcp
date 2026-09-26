# Release Checklist

## Before release

- [ ] Confirm the version and update `CHANGELOG.md`.
- [ ] Run `npm ci`, `npm run check`, and `npm pack --dry-run` in
  `plugins/zendesk-connector`.
- [ ] Review the package contents for credentials, customer data, and generated
  files.
- [ ] Build and run the Docker image with a non-production Zendesk account.
- [ ] Review OAuth scopes and enabled tool policy for the release.
- [ ] Review dependency and GitHub Actions security alerts.
- [ ] Have a second reviewer inspect authentication, policy, logging, and writes.

## Publish

- [ ] Create a signed, annotated version tag.
- [ ] Publish the GitHub release with changelog notes and checksums.
- [ ] Publish the container image with the same version tag and an immutable
  digest.
- [ ] Verify installation from the published artifact in a clean environment.

## After release

- [ ] Record artifact digests and release commit in the release record.
- [ ] Monitor reported errors and security advisories.
- [ ] Document rollback steps for the package and container image.
