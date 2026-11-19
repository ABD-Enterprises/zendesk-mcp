#!/usr/bin/env python3
"""Changelog notes as one file per change, folded into CHANGELOG.md on demand.

Why: every PR used to add its entry under `## Unreleased` in CHANGELOG.md. Each merge to main then
conflicted with every other open PR, which had to merge main again, take a fresh exact-head review and
re-run CI. From 2026-10-15 to 10-17 brew-sync PRs averaged 4.2 heads each, most of the extra ones forced
by that section. A note in its own file never conflicts.

    scripts/changelog.py check [--base REV]   validate changelog.d/; with --base, also refuse a change
                                              that adds lines to Unreleased (see below)
    scripts/changelog.py assemble             fold changelog.d/*.md into Unreleased, delete them

The Unreleased heading can be exactly `## Unreleased` or `## [Unreleased]`.

A note is `changelog.d/<slug>.md` (letters, digits, '.', '_' and '-' only; any name but README.md) holding one
or more entries:

    - [Changed] What changed and why it matters (#123)
      An indented line continues the entry above it.

The tag is one of the Keep a Changelog sections below. `assemble` puts each entry, without its tag, at
the end of the first `### <Section>` list in Unreleased (adding the list heading when it is missing),
in file-name order.

With --base, `check` compares the Unreleased section at `git merge-base REV HEAD` with the working
tree. When the change adds lines there, the section must be exactly what `assemble` makes from the
base's CHANGELOG.md and the notes the change deletes (an assemble PR changes nothing else); any other
added line fails. Bare `### <Section>` headings and blank lines are ignored,
and so are deletions: a release cut moves lines out of Unreleased into a new version section, which
reads as deletions here (keep an Unreleased heading above it; without one, check exits 2). Fixing a
typo in an existing Unreleased entry reads as an added line and fails the guard: leave it, or fix it in the
release PR that moves the section under a version heading. Hidden files in changelog.d/ (.DS_Store) are ignored. CI runs it on pull requests with --base HEAD^1: the checkout is the PR merged
into its base, so HEAD^1 is the base tip.

Runs on Python 3.9 (macOS /usr/bin/python3): no 3.10+ syntax. Exit 0 = clean, 1 = findings, 2 = usage
or git error.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

SECTIONS = ("Added", "Changed", "Deprecated", "Removed", "Fixed", "Security")
UNRELEASED_HEADINGS = ("## Unreleased", "## [Unreleased]")
NOTES_DIR = "changelog.d"
SKIP = {"README.md"}
NOTE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\.md")

Entry = tuple[str, list[str]]  # (section, lines with the tag removed)


class NoteError(ValueError):
    pass


def parse_note(name: str, text: str) -> list[Entry]:
    entries: list[Entry] = []
    current: list[str] | None = None
    for number, raw in enumerate(text.replace("\r\n", "\n").split("\n"), 1):
        line = raw.rstrip()
        if line.startswith("- ["):
            tag, sep, body = line[3:].partition("] ")
            if not sep or not body.strip():
                raise NoteError(f"{name}:{number}: expected '- [Section] text', got {line!r}")
            if tag not in SECTIONS:
                raise NoteError(f"{name}:{number}: unknown section [{tag}]; use one of "
                                + " ".join(f"[{s}]" for s in SECTIONS))
            current = [f"- {body}"]
            entries.append((tag, current))
        elif not line.strip():
            current = None
        elif current is not None and raw[:1] in (" ", "\t"):
            current.append(line)
        else:
            raise NoteError(f"{name}:{number}: neither an entry ('- [Section] text') "
                            f"nor an indented continuation: {line!r}")
    if not entries:
        raise NoteError(f"{name}: no '- [Section] text' entry")
    return entries


def note_paths(root: Path) -> list[Path]:
    folder = root / NOTES_DIR
    if not folder.is_dir():
        return []
    return sorted(p for p in folder.iterdir()
                  if p.is_file() and p.name not in SKIP and not p.name.startswith("."))


def unreleased_bounds(lines: list[str]) -> tuple[int, int]:
    """Index of the first Unreleased heading and of the first line after its section."""
    try:
        start = next(i for i, line in enumerate(lines) if line.rstrip() in UNRELEASED_HEADINGS)
    except StopIteration:
        plain, bracketed = UNRELEASED_HEADINGS
        raise NoteError(f"CHANGELOG.md has no '{plain}' or '{bracketed}' line") from None
    forms = {line.rstrip() for line in lines if line.rstrip() in UNRELEASED_HEADINGS}
    if len(forms) > 1:  # which one is "the" section would be a guess, and the guard could miss edits under the other
        raise NoteError("CHANGELOG.md has both '## Unreleased' and '## [Unreleased]'; keep one")
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")), len(lines))
    return start, end


def unreleased_body(changelog: str) -> list[str]:
    lines = changelog.split("\n")
    start, end = unreleased_bounds(lines)
    return lines[start + 1:end]


def assemble(changelog: str, entries: list[Entry]) -> str:
    lines = changelog.split("\n")
    for section, body in entries:
        start, end = unreleased_bounds(lines)
        heading = next((i for i in range(start + 1, end) if lines[i].rstrip() == f"### {section}"), None)
        if heading is None:
            at = end
            while at > start + 1 and not lines[at - 1].strip():
                at -= 1
            lines[at:at] = ["", f"### {section}", *body]
            continue
        at = next((i for i in range(heading + 1, end) if lines[i].startswith("#")), end)
        while at > heading + 1 and not lines[at - 1].strip():
            at -= 1
        lines[at:at] = body
    return "\n".join(lines)


def git(root: Path, *args: str) -> str:
    done = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)
    if done.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {done.stderr.strip() or done.returncode}")
    return done.stdout


def unreleased_findings(root: Path, base: str) -> list[str]:
    merge_base = git(root, "merge-base", base, "HEAD").strip()
    try:
        old = git(root, "show", f"{merge_base}:CHANGELOG.md")
    except RuntimeError:
        return []  # no changelog at the base: nothing to protect
    new_lines = (root / "CHANGELOG.md").read_text(encoding="utf-8").split("\n")
    start, end = unreleased_bounds(new_lines)
    new_body = new_lines[start + 1:end]
    added = Counter(new_body) - Counter(unreleased_body(old))
    added_lines = [line for line in added.elements() if line.strip() and not is_section_heading(line)]
    if not added_lines:
        return []
    entries = folded_entries(root, merge_base)
    if entries and unreleased_body(assemble(old, entries)) == new_body:
        return []  # exactly what `assemble` makes from the notes this change deletes
    sample = added_lines[0] if len(added_lines[0]) <= 100 else added_lines[0][:97] + "..."
    return [f"CHANGELOG.md: this change adds {len(added_lines)} line(s) under '{new_lines[start]}' (first: "
            f"{sample!r}), and the section is not what `scripts/changelog.py assemble` makes from the notes "
            f"this change deletes. Put the entry in {NOTES_DIR}/<slug>.md as '- [Section] text (#N)' "
            "instead; editing that section directly conflicts with every other open PR. Run assemble "
            "in a PR of its own that changes nothing else."]


def is_section_heading(line: str) -> bool:
    return line.startswith("### ") and line[4:].strip() in SECTIONS


def folded_entries(root: Path, merge_base: str) -> list[Entry]:
    """Entries of the notes this change deleted, in assemble order, less any in a note it added.

    A note re-added under another name (a rename or copy) has not been folded. Only notes this change
    added offset the deleted ones, so a note that reached main meanwhile cannot fail an assemble.
    """
    deleted: list[tuple[str, Entry]] = []
    readded: Counter[tuple[str, tuple[str, ...]]] = Counter()
    # core.quotePath=false keeps a non-ASCII note name readable; quoted names would not resolve in `git show`.
    status = git(root, "-c", "core.quotePath=false", "diff", "--name-status", "--no-renames", merge_base, "--", NOTES_DIR)
    for row in status.splitlines():
        code, _, path = row.partition("\t")
        name = Path(path).name
        if code not in ("A", "D") or name in SKIP or name.startswith("."):
            continue
        try:
            text = git(root, "show", f"{merge_base}:{path}") if code == "D" else (root / path).read_text(encoding="utf-8")
            entries = parse_note(path, text)
        except (NoteError, OSError):
            continue
        if code == "D":
            deleted += [(name, entry) for entry in entries]
        else:
            readded.update((section, tuple(body)) for section, body in entries)
    folded = []
    for _, (section, body) in sorted(deleted, key=lambda item: item[0]):
        key = (section, tuple(body))
        if readded[key]:
            readded[key] -= 1
        else:
            folded.append((section, body))
    return folded


def check(root: Path, base: str | None) -> list[str]:
    findings = []
    for path in note_paths(root):
        if path.suffix != ".md":
            findings.append(f"{NOTES_DIR}/{path.name}: notes must be .md files")
            continue
        if not NOTE_NAME.fullmatch(path.name):
            # Git quotes odd characters in paths, which breaks the guard's lookups; a plain name never needs it.
            findings.append(f"{NOTES_DIR}/{path.name}: use only letters, digits, '.', '_' and '-' in a note name")
            continue
        try:
            parse_note(f"{NOTES_DIR}/{path.name}", path.read_text(encoding="utf-8"))
        except NoteError as exc:
            findings.append(str(exc))
    if base:
        findings += unreleased_findings(root, base)
    return findings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    check_cmd = sub.add_parser("check", help="validate notes; with --base, guard the Unreleased section")
    check_cmd.add_argument("--base", help="revision to compare against (its merge base with HEAD)")
    sub.add_parser("assemble", help="fold notes into CHANGELOG.md and delete them")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args(argv)
    root: Path = args.root

    if args.command == "check":
        try:
            findings = check(root, args.base)
        except (RuntimeError, NoteError) as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            return 2
        for finding in findings:
            print(f"FAIL: {finding}")
        if not findings:
            print(f"changelog: {len(note_paths(root))} note(s) OK")
        return 1 if findings else 0

    problems = check(root, None)
    if problems:  # fold nothing while any note is malformed or not a .md file
        for problem in problems:
            print(f"ERROR: {problem}", file=sys.stderr)
        return 1
    paths = note_paths(root)
    try:
        entries = [e for p in paths for e in parse_note(f"{NOTES_DIR}/{p.name}", p.read_text(encoding="utf-8"))]
        changelog = root / "CHANGELOG.md"
        changelog.write_text(assemble(changelog.read_text(encoding="utf-8"), entries), encoding="utf-8")
    except NoteError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    for path in paths:
        path.unlink()
    print(f"changelog: folded {len(entries)} entr{'y' if len(entries) == 1 else 'ies'} "
          f"from {len(paths)} note(s) into CHANGELOG.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
