#!/usr/bin/env bash
# Check the release tag against the package version and the ancestry result.
#
# Usage:
#   check-release-tag.sh <tag> <package.json-path> <ancestor-ok>
#
# The script exits 0 only when all three conditions hold:
#   - the tag has the shape v<major>.<minor>.<patch> with an optional
#     pre-release suffix,
#   - the tag without its leading "v" is exactly the version of the package
#     file,
#   - the ancestry result is 1.
#
# The ancestry check is not performed here. The caller runs
# `git merge-base --is-ancestor` and passes its result as <ancestor-ok> (0 or
# 1), so the script needs no git state and can be tested on its own.
#
# Every violated condition is reported on its own line on stderr and the
# script exits 1, so a caller sees all the reasons at once and stops before
# any build or push.
#
# The script needs bash, node and the standard utilities.

set -euo pipefail

# The pattern lives in a variable on purpose. Bash reads the characters of
# the right-hand side of `=~` as operators when they appear directly there,
# so an unquoted variable expansion is matched as a regular expression.
#
# The optional suffix must start with a dash. A suffix that may also start
# with a dot accepts a fourth number: "v1.2.3.4" would pass as the version
# "1.2.3" with the suffix ".4", and four numbers are not a version.
readonly TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'

usage() {
  echo "usage: check-release-tag.sh <tag> <package.json-path> <ancestor-ok>" >&2
}

if [ "$#" -ne 3 ]; then
  usage
  exit 1
fi

tag="$1"
package_json="$2"
ancestor_ok="$3"

failures=0

report() {
  echo "Refusing to publish: $1" >&2
  failures=$((failures + 1))
}

if [[ ! "$tag" =~ $TAG_PATTERN ]]; then
  report "tag '$tag' does not have the shape 'v<major>.<minor>.<patch>' with an optional pre-release suffix."
fi

# The version is read and compared with node, which the runner always has.
# The file is parsed as JSON, so the whitespace of the file does not matter.
#
# The comparison itself happens in node as well. A shell command substitution
# drops the trailing newlines of its output, so a version that ends in a
# newline would be compared as if it had none and would pass the exactness
# check. Node compares the two strings byte for byte and reports the verdict.
#
# The path and the version of the tag travel in the environment, so no
# quoting of the file name is needed. The version is printed back with its
# control characters escaped: it fits on one line, and a diagnostic shows the
# difference instead of hiding it.
package_version=""
version_read=1
if ! version_output="$(PACKAGE_JSON_PATH="$package_json" TAG_VERSION="${tag#v}" node --input-type=commonjs -e '
const fs = require("node:fs");
const file = process.env.PACKAGE_JSON_PATH;
const tagVersion = process.env.TAG_VERSION;
let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (error) {
  process.stderr.write("the package file cannot be parsed: " + error.message + "\n");
  process.exit(1);
}
if (typeof parsed !== "object" || parsed === null || typeof parsed.version !== "string" || parsed.version === "") {
  process.stderr.write("the package file carries no non-empty version string\n");
  process.exit(1);
}
const version = parsed.version;
const printable = version.replace(/[\u0000-\u001f\u007f]/g, (character) => {
  switch (character) {
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    default:
      return "\\x" + character.codePointAt(0).toString(16).padStart(2, "0");
  }
});
process.stdout.write((version === tagVersion ? "MATCH" : "MISMATCH") + "\n" + printable + "\n");
')"; then
  report "the package version could not be read from '$package_json'."
  version_read=0
fi

if [ "$version_read" -eq 1 ]; then
  package_version="${version_output#*$'\n'}"
  if [ "${version_output%%$'\n'*}" != "MATCH" ]; then
    report "tag '$tag' does not match package version '$package_version'."
  fi
fi

case "$ancestor_ok" in
  1) ;;
  0)
    report "the release commit is not an ancestor of origin/main."
    ;;
  *)
    report "the ancestry result '$ancestor_ok' is neither 0 nor 1."
    ;;
esac

if [ "$failures" -gt 0 ]; then
  echo "Found ${failures} release guard failure(s) for tag '$tag'." >&2
  exit 1
fi

echo "Tag '$tag' matches package version '$package_version'."
echo "The release commit is contained in origin/main."
exit 0
