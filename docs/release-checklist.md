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
- [ ] One-time, only while `npm view @abd-enterprises/zendesk-mcp version`
  fails with `E404` — the package has never been published: npm cannot
  configure a trusted publisher for a package that does not exist yet (the
  trusted-publisher settings live with the package), and a first OIDC
  publish will not create it, so the package needs a manual bootstrap
  publish first. From a clean checkout of the release commit, in
  `plugins/zendesk-connector`, set a placeholder version without committing
  it (`npm version 0.0.0 --no-git-tag-version`), run
  `npm ci --ignore-scripts` and `npm run build` (the publish re-runs the
  same build through `prepack`), then publish it interactively under a
  non-release dist-tag so `latest` stays free for the first workflow
  publish: `npm login`, then
  `npm publish --access public --tag bootstrap`. Restore the version files
  afterwards (`git checkout -- package.json package-lock.json`) and log
  out again (`npm logout`), so no publish credential stays in `~/.npmrc`.
  This placeholder carries no provenance and is the only version ever
  published by hand — the registration below and every release after it
  use OIDC. Until the first release publish lands there is no `latest`
  dist-tag, so an unversioned `npm install @abd-enterprises/zendesk-mcp`
  fails with ETARGET during that window; that is expected.
- [ ] Confirm npm trusted publishing is armed (one-time per package, plus a
  per-release variable check): on npmjs.com, for
  `@abd-enterprises/zendesk-mcp`, Settings → Trusted Publisher → GitHub
  Actions, register `ABD-Enterprises/zendesk-mcp` with workflow file
  `release.yml` (the caller — GitHub's OIDC `workflow_ref` claim names the
  calling workflow of a reusable-workflow job), and grant **Allow npm
  publish** — configurations created
  after 2026-09-03 default to stage-publish only, which the workflow's
  `npm publish` does not satisfy. Confirm the repo variable is set:
  `gh variable get NPM_TRUSTED_PUBLISHING` must print `true`. Both are
  required before the tag push below, and they fail differently: without
  the variable the release run goes green but publishes only the image,
  silently skipping npm; with the variable set but the trusted publisher
  missing or lacking **Allow npm publish**, the publish job runs and
  fails red. A first registration expires if the first publish does not
  land within 2 days.

## Publish

The container image is published automatically. Pushing a signed, annotated
version tag `v*` starts `.github/workflows/release.yml`, which publishes
`ghcr.io/abd-enterprises/zendesk-mcp:<version>`, where the image tag is the
version without its leading `v`. The same tag also publishes the npm package
`@abd-enterprises/zendesk-mcp` automatically, through the reusable
`.github/workflows/npm-publish.yml` workflow, using OIDC trusted publishing —
no npm token or password is ever stored. `plugins/zendesk-connector/Dockerfile`
only builds an image, and the CI workflow builds the image without pushing it:
`release.yml` is the only workflow that pushes an image.

- [ ] Confirm that `plugins/zendesk-connector/package.json` carries the
  intended `version`, that `CHANGELOG.md` has a section for it, and that the
  release commit is contained in `main`.
- [ ] Create a signed, annotated version tag and push it:
  `git tag -s v<version> -m "v<version>"`, then `git push origin v<version>`.
- [ ] Wait for the `Publish image to GHCR` job to succeed. The workflow requires
  the tag to equal the `package.json` version and the tagged commit to be
  contained in `main`, runs the connector checks (`npm ci`, `npm run check`,
  `npm pack --dry-run`), refuses to overwrite an existing GHCR tag, then builds
  and pushes the image. The preflight only continues when the registry
  positively reports the manifest as unknown; a bare "not found" answer, a
  proxy or CDN failure, or any other registry error stops the release before
  any build or push.
- [ ] Verify the published image and record its digest:
  `docker pull ghcr.io/abd-enterprises/zendesk-mcp:<version>`, then
  `docker image inspect ghcr.io/abd-enterprises/zendesk-mcp:<version> --format
  '{{index .RepoDigests 0}}'`. The pull needs `docker login ghcr.io` while
  the package is still private; the workflow summary reports the published
  reference and digest as well.
- [ ] Publish the GitHub release with changelog notes and checksums.
- [ ] Verify the npm package published with the tag: the `publish to npm`
  job runs in the same release after the image job and publishes
  `@abd-enterprises/zendesk-mcp` with OIDC provenance — no token or
  one-time password is ever used by the workflow, and nothing is stored in
  the repository. (The one-time bootstrap publish under Before release is
  the single exception, and it runs by hand, not in CI.) If the job was
  skipped in an otherwise green run, `NPM_TRUSTED_PUBLISHING` is not set
  to `true` (see Before release); in a red run the image job failing
  skips it as well. If it failed with ENEEDAUTH ("Unable to
  authenticate"), the trusted publisher is not registered or npm matched a
  different workflow filename — in the latter case add
  `npm-publish.yml` as a second trusted publisher (npm does not validate
  the filename when saving). A publisher that is registered but was saved
  without **Allow npm publish** authenticates and is then refused at the
  registry with a permission error, not ENEEDAUTH. Confirm the result with
  `npm view @abd-enterprises/zendesk-mcp version` and the provenance on the
  npm package page.
- [ ] Set the GHCR package visibility to public in the package settings; a new
  package starts private. Log out of the registry before the check, because the
  verification step above logged in and Docker reuses the stored credential —
  the pull would then succeed against a still-private package:
  `docker logout ghcr.io`. Confirm an anonymous pull works:
  `docker pull ghcr.io/abd-enterprises/zendesk-mcp:<version>`.
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
  `npm deprecate @abd-enterprises/zendesk-mcp@<bad-version> "use
  <good-version> instead"`. Deprecation is reversible and is the safer
  default.
- Unpublish the bad version only when it must not be installable at all:
  `npm unpublish @abd-enterprises/zendesk-mcp@<bad-version>`. Within 72
  hours of publishing, npm accepts the unpublish without further conditions.
  After 72 hours it stays self-service while the package has fewer than 300
  weekly downloads, no other package depends on it, and it has a single
  owner or maintainer; only when one of those conditions fails does the
  unpublish need an npm support request. An unpublish also leaves the
  version in caches and lockfiles that already resolved it, and it does not
  remove the other published versions.
- Move the `latest` tag back to the last good version:
  `npm dist-tag add @abd-enterprises/zendesk-mcp@<good-version> latest`.
  (The deprecate and unpublish commands above act only on versions that
  are actually on the registry; until the first release publish lands, the
  only version there is the `bootstrap` placeholder from Before release.)
- Ship a fixed version instead: bump the `package.json` version to a new one,
  tag it (the workflow refuses to reuse a published version), and push the
  tag. The release workflow publishes both artifacts for that tag — the
  image and the npm package — so there is no separate npm step; confirm it
  with `npm view @abd-enterprises/zendesk-mcp version`.

### Container image

The release workflow's refusal to overwrite an existing GHCR tag guards the
automatic publish path: a tag push for a version that is already published
fails. A deliberate manual retag is a different action — it replaces the tag
in the registry under the same version, and the workflow guard does not apply
to it.

- Move the bad tag back to the previous digest by copying the manifest:
  `docker buildx imagetools create --tag
  ghcr.io/abd-enterprises/zendesk-mcp:<bad-version>
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
  that is already published, so the fix needs a new version: a new tag, from
  which the release workflow publishes both the image and the npm package.
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
