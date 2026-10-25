#!/usr/bin/env bash
# Classify the answer of `docker manifest inspect` for a container image.
#
# Usage:
#   check-manifest.sh <inspect-status> [image-reference] [image-tag]
#
# The output of the inspect command is read from stdin and the exit status of
# the inspect command is passed as the first argument. The script exits 0 only
# when that output proves that the manifest does not exist yet, and 1 for
# every other answer. A caller must stop before any build or push when the
# script exits 1.
#
# A successful inspect (status 0) means the manifest exists; that case belongs
# to the caller, which refuses it before calling this script.
#
# Only a manifest-specific "unknown manifest" answer proves the tag is free.
# A bare 404 or "not found" is not evidence: proxies, CDNs and local client
# failures produce the same text while the image may well be published.
# Every other answer means the registry could not be consulted, so the
# release stops here, before any build or push.
#
# The script has no dependencies beyond bash and the standard utilities.

set -euo pipefail

usage() {
  echo "usage: check-manifest.sh <inspect-status> [image-reference] [image-tag]" >&2
}

if [ "$#" -lt 1 ]; then
  usage
  exit 1
fi

inspect_status="$1"
image="${2:-}"
tag="${3:-}"

case "$inspect_status" in
  ''|*[!0-9]*)
    echo "The inspect status '$inspect_status' is not a number." >&2
    usage
    exit 1
    ;;
esac

if ! inspect_output="$(cat)"; then
  echo "Refusing to publish: the registry response could not be read." >&2
  exit 1
fi

normalized="$(printf '%s' "$inspect_output" | tr '[:upper:]' '[:lower:]' | tr '_' ' ')"
case "$normalized" in
  *"manifest unknown"*|*"no such manifest"*|*"name unknown"*)
    if [ -n "$tag" ]; then
      echo "Image tag '$tag' is not published yet."
    else
      echo "The image tag is not published yet."
    fi
    exit 0
    ;;
esac

if [ -n "$image" ]; then
  echo "Refusing to publish: the registry could not be consulted to determine whether '$image' is already published." >&2
else
  echo "Refusing to publish: the registry could not be consulted to determine whether the image is already published." >&2
fi
echo "docker manifest inspect exited with status $inspect_status and the registry did not answer with a manifest-specific 'unknown manifest' error." >&2
echo "--- registry response ---" >&2
printf '%s\n' "$inspect_output" >&2
echo "--- end of registry response ---" >&2
exit 1
