#!/usr/bin/env bash
# Check the action pins in the workflow files.
#
# Usage:
#   check-action-pins.sh [workflow-directory]
#
# The workflow directory defaults to the .github/workflows directory of the
# repository that holds this script. Every *.yml and *.yaml file in it is read
# and every remote `uses: owner/repo@ref` reference in it is checked. That is
# the same file set that the actionlint step of the workflow-lint job lints, so
# no workflow file escapes the check.
#
# Why this exists: a `uses:` pin that carries a truncated commit SHA is not a
# lint error. actionlint accepts it, but GitHub refuses to start the workflow
# at all, so the run fails with a startup failure and no log that names the
# cause. This script reports the offending pin while the workflow still
# parses.
#
# The rules:
#   - A ref that consists of lowercase hexadecimal characters only is a commit
#     SHA and must carry all 40 characters.
#   - Any other ref (a tag such as v1.2.3, a branch name, a mixed case
#     identifier) is accepted as it is. The length rule does not apply to it.
#   - An empty ref is reported: it is not a tag, it is nothing.
#   - Local actions (./path) and container images (docker://image) are
#     skipped, and so is a ref that is an expression (${{ ... }}).
#
# The script prints one line per offending pin to stderr and exits 1. It
# prints a single OK line and exits 0 when every pin passes.
#
# The script has no dependencies beyond bash and the standard utilities.

set -euo pipefail
export LC_ALL=C

readonly EXPECTED_SHA_LENGTH=40

# The patterns live in variables on purpose. Bash reads the characters `|`
# and `>` as operators when they appear directly in the right-hand side of
# `=~`, so a pattern such as `[|>]` written inline makes the whole
# conditional expression a syntax error and the script stops with exit
# status 2 before it checks a single pin. An unquoted variable expansion is
# matched as a regular expression, so the patterns keep their meaning.
readonly BLOCK_SCALAR_PATTERN='^([^:]*):[[:space:]]*[|>][0-9]*[-+]?[[:space:]]*(#.*)?$'
readonly USES_PATTERN='^[[:space:]]*-?[[:space:]]*uses:[[:space:]]+(.*)$'
readonly REMOTE_REFERENCE_PATTERN='^[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+$'
readonly HEX_PATTERN='^[0-9a-f]+$'

usage() {
  echo "usage: check-action-pins.sh [workflow-directory]" >&2
}

if [ "$#" -gt 1 ]; then
  usage
  exit 1
fi

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "${script_directory}/../.." && pwd)"

if [ "$#" -eq 1 ]; then
  workflows_directory="$1"
else
  workflows_directory="${repository_root}/.github/workflows"
fi

if [ ! -d "$workflows_directory" ]; then
  echo "The workflow directory '${workflows_directory}' does not exist." >&2
  exit 1
fi

display_directory="$workflows_directory"
case "$workflows_directory" in
  "${repository_root}/"*) display_directory="${workflows_directory#"${repository_root}/"}" ;;
esac

shopt -s nullglob
workflow_files=("${workflows_directory}"/*.yml "${workflows_directory}"/*.yaml)
shopt -u nullglob

if [ "${#workflow_files[@]}" -eq 0 ]; then
  echo "No workflow files found in '${display_directory}'." >&2
  exit 1
fi

# A fixed order keeps the report the same from run to run, also when the
# directory holds both .yml and .yaml files.
sorted_files=()
while IFS= read -r file; do
  sorted_files+=("$file")
done < <(printf '%s\n' "${workflow_files[@]}" | LC_ALL=C sort)
workflow_files=("${sorted_files[@]}")

trim() {
  local text="$1"
  text="${text#"${text%%[![:space:]]*}"}"
  text="${text%"${text##*[![:space:]]}"}"
  printf '%s' "$text"
}

failures=0
checked=0

report() {
  # $1: the workflow file, $2: the pin, $3: the length of the ref
  echo "$1: invalid action pin '$2': the ref has $3 characters, expected ${EXPECTED_SHA_LENGTH} lowercase hexadecimal characters" >&2
  failures=$((failures + 1))
}

for workflow_file in "${workflow_files[@]}"; do
  relative_file="$workflow_file"
  case "$workflow_file" in
    "${repository_root}/"*) relative_file="${workflow_file#"${repository_root}/"}" ;;
  esac
  in_block=0
  block_indent=0
  while IFS= read -r line || [ -n "$line" ]; do
    # A block scalar (run: | and the like) holds text, not keys. Its lines
    # are skipped, so a line that reads like a key inside such a block does
    # not produce a false report. The header may carry a trailing comment
    # (run: | # note), so it stays a block scalar header.
    leading_whitespace="${line%%[![:space:]]*}"
    indent=${#leading_whitespace}
    if [ "$in_block" -eq 1 ]; then
      if [ "${line//[[:space:]]/}" != "" ] && [ "$indent" -le "$block_indent" ]; then
        in_block=0
      else
        continue
      fi
    fi
    if [[ "$line" =~ $BLOCK_SCALAR_PATTERN ]]; then
      in_block=1
      block_indent="$indent"
      continue
    fi
    if [[ ! "$line" =~ $USES_PATTERN ]]; then
      continue
    fi
    value="${BASH_REMATCH[1]}"
    value="${value%% #*}"
    value="$(trim "$value")"
    # A quoted value loses its first and its last character. The substring
    # form is used on purpose: inside double quotes a backslash does not
    # escape a single quote, so `${value#\'}` would look for a backslash.
    case "$value" in
      \"*|\'*) value="$(trim "${value:1}")"; value="$(trim "${value%?}")" ;;
    esac
    case "$value" in
      '') continue ;;
      ./*|../*) continue ;;
      docker://*) continue ;;
      *'${{'*) continue ;;
    esac
    if [[ "$value" != *@* ]]; then
      continue
    fi
    reference="${value%%@*}"
    ref="${value##*@}"
    if [[ ! "$reference" =~ $REMOTE_REFERENCE_PATTERN ]]; then
      continue
    fi
    checked=$((checked + 1))
    if [ -z "$ref" ]; then
      report "$relative_file" "$value" 0
      continue
    fi
    if [[ "$ref" =~ $HEX_PATTERN ]]; then
      length=${#ref}
      if [ "$length" -ne "$EXPECTED_SHA_LENGTH" ]; then
        report "$relative_file" "$value" "$length"
      fi
    fi
  done < "$workflow_file"
done

if [ "$failures" -gt 0 ]; then
  echo "Found ${failures} action pin(s) in '${display_directory}' that are not a full ${EXPECTED_SHA_LENGTH} character commit SHA." >&2
  exit 1
fi

echo "OK: checked ${checked} action pin(s) in '${display_directory}', every pin is valid."
exit 0
