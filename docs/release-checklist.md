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

The container image is published automatically. Pushing a signed, annotated
version tag `v*` starts `.github/workflows/release.yml`, which publishes
`ghcr.io/abd-enterprises/zendesk-mcp:<version>`, where the image tag is the
version without its leading `v`. The same tag also publishes the npm package
`@abd-enterprises/zendesk-mcp` automatically, through the reusable
`.github/workflows/npm-publish.yml` workflow, using OIDC trusted publishing —
no npm token or password is ever stored. `plugins/zendesk-connector/Dockerfile`
only builds an image, and the CI workflow builds the image without pushing it:
`release.yml` is the only workflow that pushes.

- [ ] Confirm that `plugins/zendesk-connector/package.json` carries the
  intended `version`, that `CHANGELOG.md` has a section for it, and that the
  release commit is contained in `main`.
- [ ] Create a signed, annotated version tag and push it:
  `git tag -s v0.6.0 -m "v0.6.0"`, then `git push origin v0.6.0`.
- [ ] Wait for the `Publish image to GHCR` job to succeed. The workflow requires
  the tag to equal the `package.json` version and the tagged commit to be
  contained in `main`, runs the connector checks (`npm ci`, `npm run check`,
  `npm pack --dry-run`), refuses to overwrite an existing GHCR tag, then builds
  and pushes the image. The preflight only continues when the registry
  positively reports the manifest as unknown; a bare "not found" answer, a
  proxy or CDN failure, or any other registry error stops the release before
  any build or push.
- [ ] Verify the published image and record its digest:
  `docker pull ghcr.io/abd-enterprises/zendesk-mcp:0.6.0`, then
  `docker image inspect ghcr.io/abd-enterprises/zendesk-mcp:0.6.0 --format
  '{{index .RepoDigests 0}}'`. The pull needs `docker login ghcr.io` while
  the package is still private; the workflow summary reports the published
  reference and digest as well.
- [ ] Publish the GitHub release with changelog notes and checksums.
- [ ] Verify the npm package published with the tag: the `publish to npm`
  job runs the same release after the image job and publishes
  `@abd-enterprises/zendesk-mcp` with OIDC provenance — no token or
  one-time password is ever used, and nothing is stored in the repository.
  Publishing stays off until the operator has registered the trusted
  publisher on npmjs.com (Settings → Trusted Publisher → GitHub Actions,
  workflow file `release.yml`; the first publish must land within 2 days of
  registration) and set the repo variable `NPM_TRUSTED_PUBLISHING=true`;
  until then the job is skipped. Confirm the result with
  `npm view @abd-enterprises/zendesk-mcp version` and the provenance on the
  npm package page.
- [ ] Set the GHCR package visibility to public in the package settings; a new
  package starts private. Log out of the registry before the check, because the
  verification step above logged in and Docker reuses the stored credential —
  the pull would then succeed against a still-private package:
  `docker logout ghcr.io`. Confirm an anonymous pull works:
  `docker pull ghcr.io/abd-enterprises/zendesk-mcp:0.6.0`.
- [ ] Verify installation from the published artifact in a clean environment.

## After release

- [ ] Record artifact digests and release commit in the release record,
  `docs/release-records.md`.
- [ ] Monitor reported errors and security advisories.

## Rollback

Roll back the published artifacts first, and revert the release commit only
when the commit itself is the problem. A published version cannot be
republished by the workflow: it refuses to overwrite an existing GHCR tag, and
the tag must equal the `package.json` version. Rolling an image back therefore
means moving the tag by hand, not re-running the release.

When the release exposed a credential, revoke that credential first. A revert
alone does not remove it: the value stays valid in the git history and in the
published artifacts. See [Leaked credential](#leaked-credential).

### npm package

- Deprecate the bad version and keep it installable:
  `npm deprecate @abd-enterprises/zendesk-mcp@0.6.0 "use 0.6.1 instead"`.
  Deprecation is reversible and is the safer default.
- Unpublish the bad version only when it must not be installable at all:
  `npm unpublish @abd-enterprises/zendesk-mcp@0.6.0`. Within 72 hours of
  publishing, npm accepts the unpublish without further conditions. After 72
  hours it stays self-service while the package has fewer than 300 weekly
  downloads, no other package depends on it, and it has a single owner or
  maintainer; only when one of those conditions fails does the unpublish need
  an npm support request. An unpublish also leaves the version in caches and
  lockfiles that already resolved it, and it does not remove the other
  published versions.
- Move the `latest` tag back to the last good version:
  `npm dist-tag add @abd-enterprises/zendesk-mcp@0.5.0 latest`.
- Ship a fixed version instead: bump the `package.json` version to a new one,
  tag it (the workflow refuses to reuse a published version), and let the
  release workflow publish the matching image. The npm release stays a
  separate manual step, so publish the fixed version as well: run
  `npm publish` in `plugins/zendesk-connector` and confirm it with
  `npm view @abd-enterprises/zendesk-mcp version`.

### Container image

The release workflow's refusal to overwrite an existing GHCR tag guards the
automatic publish path: a tag push for a version that is already published
fails. A deliberate manual retag is a different action — it replaces the tag
in the registry under the same version, and the workflow guard does not apply
to it.

- Move the bad tag back to the previous digest by copying the manifest:
  `docker buildx imagetools create --tag
  ghcr.io/abd-enterprises/zendesk-mcp:0.6.0
  ghcr.io/abd-enterprises/zendesk-mcp@sha256:<previous-digest>`. Without
  `buildx`, pull the previous digest, retag it locally with `docker tag`, and
  push it again.
- Or delete the bad package version in the GitHub UI (package settings,
  versions, delete), which removes the tag, and publish the good image under
  that tag again.
- Record the digest the tag now resolves to in the release record.

### Leaked credential

A credential that reached a release is compromised, whatever happens to the
release afterwards: the value stays valid in the git history, in the published
image, and in every copy of either. Revoke it in the system that issued it
before anything else — rotate the OAuth client secret, invalidate the access
and refresh tokens — and distribute the replacement. Removing the value from
the repository does not invalidate it anywhere else.

- Delete the published image version that carries it, in the GitHub UI
  (package settings, versions, delete), so the leaked value cannot be pulled
  from GHCR. The npm package carries the same risk: deprecate the version, and
  unpublish it when the value must not remain installable at all, subject to
  the conditions npm applies (see [npm package](#npm-package)).
- Ask the owner to decide whether the value is removed from the git history.
  A history rewrite is an owner decision: it rewrites commits and tags, so
  the release tag and the release record have to be updated with it, and the
  artifacts have to be released again afterwards.
- Release a fixed version afterwards. The workflow cannot republish a version
  that is already published, so the fix needs a new version: a new tag for
  the image, and a separate `npm publish` for the package.
- Report suspected credential exposure as described in
  [SECURITY.md](../SECURITY.md).

### Release commit on `main`

- Revert the release commit on `main` with a revert commit when the commit
  itself is wrong — a broken build, or a version that must not exist — and
  release a new version afterwards. The release workflow requires the tagged
  commit to be contained in `main`, so a revert that lands after the tag does
  not withdraw the published image.
- Do not use a revert as the remedy for a leaked credential: it removes the
  value from the tip of `main` but leaves it in the history and in the
  published artifacts. Revoke the credential and handle the artifacts as
  described under [Leaked credential](#leaked-credential).
- Leave the commit in place when only the published artifacts are bad, and
  roll back the npm version and the image tag as described above.
