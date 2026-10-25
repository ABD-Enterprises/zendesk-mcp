// Structural check for CHANGELOG.md.
//
// Usage:
//   node scripts/check-changelog.mjs [path]      check a changelog file
//                                               (default: CHANGELOG.md)
//   node scripts/check-changelog.mjs --self-test  run the built-in fixtures
//
// The script has no dependencies and needs Node.js 20 or newer.
//
// Rules enforced:
//   - exactly one `## Unreleased` section, and it is the first section
//   - every other section heading is a semantic version
//   - version sections are ordered newest first (semver precedence, not
//     string order)
//   - no section is empty
//
// A violation is printed on its own line to stderr and the script exits
// non-zero; a clean file prints one OK line to stdout and exits zero.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_CHANGELOG_PATH = path.join(REPOSITORY_ROOT, "CHANGELOG.md");

// A level-2 markdown heading opens a section. Level-3 and deeper headings
// belong to the section they appear in.
const SECTION_HEADING = /^##[ \t]+(.+?)[ \t]*$/;
const UNRELEASED_HEADING = /^unreleased$/i;
// The official semantic-version pattern: no leading zeroes, optional
// pre-release and build metadata.
const SEMANTIC_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function parseSemanticVersion(heading) {
  const match = SEMANTIC_VERSION.exec(heading);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    preRelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePreRelease(left, right) {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  // A release outranks a pre-release of the same core version.
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    const leftIsNumber = /^\d+$/.test(leftPart);
    const rightIsNumber = /^\d+$/.test(rightPart);
    if (leftIsNumber && rightIsNumber) {
      const leftValue = Number(leftPart);
      const rightValue = Number(rightPart);
      if (leftValue !== rightValue) {
        return leftValue < rightValue ? -1 : 1;
      }
    } else if (leftIsNumber) {
      // Numeric identifiers always have lower precedence than alphanumeric
      // ones.
      return -1;
    } else if (rightIsNumber) {
      return 1;
    } else if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }
  if (left.length === right.length) {
    return 0;
  }
  return left.length < right.length ? -1 : 1;
}

function compareSemanticVersions(left, right) {
  const core = ["major", "minor", "patch"];
  for (const part of core) {
    if (left[part] !== right[part]) {
      return left[part] < right[part] ? -1 : 1;
    }
  }
  // Build metadata does not affect precedence.
  return comparePreRelease(left.preRelease, right.preRelease);
}

function parseSections(markdown) {
  const lines = markdown.split(/\r?\n/);
  const sections = [];
  let current = null;
  lines.forEach((line, index) => {
    const match = SECTION_HEADING.exec(line);
    if (match) {
      current = { heading: match[1], line: index + 1, body: [] };
      sections.push(current);
      return;
    }
    if (current) {
      current.body.push(line);
    }
  });
  return sections;
}

function checkChangelog(markdown) {
  const violations = [];
  const sections = parseSections(markdown);

  if (sections.length === 0) {
    violations.push(
      "no sections found: expected an 'Unreleased' section followed by version sections",
    );
    return { violations, versionCount: 0 };
  }

  const unreleasedSections = sections.filter((section) =>
    UNRELEASED_HEADING.test(section.heading),
  );

  if (unreleasedSections.length === 0) {
    violations.push("no 'Unreleased' section found");
  } else if (unreleasedSections.length > 1) {
    const lines = unreleasedSections.map((section) => section.line).join(", ");
    violations.push(
      `found ${unreleasedSections.length} 'Unreleased' sections (lines ${lines}); exactly one is allowed`,
    );
  } else {
    const [unreleased] = unreleasedSections;
    if (sections[0] !== unreleased) {
      violations.push(
        `the 'Unreleased' section (line ${unreleased.line}) must be the first section (line ${sections[0].line})`,
      );
    }
    if (unreleased.heading !== "Unreleased") {
      violations.push(
        `the 'Unreleased' section heading must be spelled 'Unreleased', found '${unreleased.heading}'`,
      );
    }
  }

  const versionSections = sections.filter(
    (section) => !UNRELEASED_HEADING.test(section.heading),
  );
  const parsedVersions = [];
  for (const section of versionSections) {
    const version = parseSemanticVersion(section.heading);
    if (!version) {
      violations.push(
        `section heading '${section.heading}' (line ${section.line}) is not a semantic version`,
      );
      continue;
    }
    parsedVersions.push({ section, version });
  }

  for (let index = 0; index + 1 < parsedVersions.length; index += 1) {
    const current = parsedVersions[index];
    const next = parsedVersions[index + 1];
    const order = compareSemanticVersions(current.version, next.version);
    if (order === 0) {
      violations.push(
        `version ${current.section.heading} (line ${current.section.line}) and ${next.section.heading} (line ${next.section.line}) have the same precedence; versions must be strictly ordered newest first`,
      );
    } else if (order < 0) {
      violations.push(
        `version ${current.section.heading} (line ${current.section.line}) must come after ${next.section.heading} (line ${next.section.line}); versions are ordered newest first`,
      );
    }
  }

  for (const section of sections) {
    if (!section.body.some((line) => line.trim() !== "")) {
      violations.push(
        `section '${section.heading}' (line ${section.line}) is empty`,
      );
    }
  }

  return { violations, versionCount: versionSections.length };
}

const SELF_TESTS = [
  {
    name: "an Unreleased section followed by descending versions",
    markdown: [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "No changes recorded yet.",
      "",
      "## 0.5.0",
      "",
      "- Add a thing.",
      "",
      "## 0.4.0",
      "",
      "- Add another thing.",
      "",
    ].join("\n"),
    expectedViolations: 0,
  },
  {
    name: "a file without any section",
    markdown: "# Changelog\n",
    expectedViolations: 1,
    expectContains: "no sections found",
  },
  {
    name: "a file without an Unreleased section",
    markdown: "## 0.5.0\n\n- Add a thing.\n",
    expectedViolations: 1,
    expectContains: "no 'Unreleased' section found",
  },
  {
    name: "an Unreleased section that is not first",
    markdown:
      "## 0.5.0\n\n- Add a thing.\n\n## Unreleased\n\nNo changes recorded yet.\n",
    expectedViolations: 1,
    expectContains: "must be the first section",
  },
  {
    name: "two Unreleased sections",
    markdown:
      "## Unreleased\n\nNo changes recorded yet.\n\n## Unreleased\n\nNo changes recorded yet.\n",
    expectedViolations: 1,
    expectContains: "exactly one is allowed",
  },
  {
    name: "a section heading that is not a semantic version",
    markdown:
      "## Unreleased\n\nNo changes recorded yet.\n\n## 0.5\n\n- Add a thing.\n",
    expectedViolations: 1,
    expectContains: "is not a semantic version",
  },
  {
    name: "versions that are not ordered newest first",
    markdown:
      "## Unreleased\n\nNo changes recorded yet.\n\n## 0.9.0\n\n- Add a thing.\n\n## 0.10.0\n\n- Add another thing.\n",
    expectedViolations: 1,
    expectContains: "must come after",
  },
  {
    name: "versions compared by precedence, not by string order",
    markdown:
      "## Unreleased\n\nNo changes recorded yet.\n\n## 0.10.0\n\n- Add a thing.\n\n## 0.9.0\n\n- Add another thing.\n",
    expectedViolations: 0,
  },
  {
    name: "a release ordered before its pre-release",
    markdown:
      "## Unreleased\n\nNo changes recorded yet.\n\n## 1.0.0\n\n- Add a thing.\n\n## 1.0.0-alpha.1\n\n- Add another thing.\n",
    expectedViolations: 0,
  },
  {
    name: "a repeated version",
    markdown:
      "## Unreleased\n\nNo changes recorded yet.\n\n## 0.5.0\n\n- Add a thing.\n\n## 0.5.0\n\n- Add another thing.\n",
    expectedViolations: 1,
    expectContains: "have the same precedence",
  },
  {
    name: "an empty section",
    markdown:
      "## Unreleased\n\nNo changes recorded yet.\n\n## 0.5.0\n\n## 0.4.0\n\n- Add a thing.\n",
    expectedViolations: 1,
    expectContains: "is empty",
  },
];

function runSelfTests() {
  let failures = 0;
  for (const test of SELF_TESTS) {
    const { violations } = checkChangelog(test.markdown);
    const countMatches = violations.length === test.expectedViolations;
    const textMatches =
      test.expectContains === undefined ||
      violations.some((violation) => violation.includes(test.expectContains));
    if (!countMatches || !textMatches) {
      failures += 1;
      const expected =
        test.expectContains === undefined
          ? `${test.expectedViolations} violation(s)`
          : `${test.expectedViolations} violation(s) containing '${test.expectContains}'`;
      const found = violations.length === 0 ? "none" : violations.join(" | ");
      process.stderr.write(
        `self-test failed: ${test.name}: expected ${expected}, got ${violations.length}: ${found}\n`,
      );
    }
  }
  if (failures === 0) {
    process.stdout.write(
      `OK: ${SELF_TESTS.length} changelog self-tests passed.\n`,
    );
  }
  return failures;
}

function displayPath(filePath) {
  const relative = path.relative(REPOSITORY_ROOT, filePath);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  return filePath;
}

function main() {
  const args = process.argv.slice(2);
  const unknownFlags = args.filter(
    (arg) => arg.startsWith("--") && arg !== "--self-test",
  );

  if (unknownFlags.length > 0) {
    process.stderr.write(
      `unknown option(s): ${unknownFlags.join(", ")}; usage: node scripts/check-changelog.mjs [path] | --self-test\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (args.includes("--self-test")) {
    process.exitCode = runSelfTests() === 0 ? 0 : 1;
    return;
  }

  const fileArgument = args.find((arg) => !arg.startsWith("--"));
  const changelogPath = fileArgument
    ? path.resolve(process.cwd(), fileArgument)
    : DEFAULT_CHANGELOG_PATH;
  const label = displayPath(changelogPath);

  let markdown;
  try {
    markdown = readFileSync(changelogPath, "utf8");
  } catch (error) {
    process.stderr.write(
      `${label}: cannot read the changelog file: ${error.message}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const { violations, versionCount } = checkChangelog(markdown);
  if (violations.length > 0) {
    for (const violation of violations) {
      process.stderr.write(`${label}: ${violation}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `OK: ${label} has one 'Unreleased' section, ${versionCount} version section(s) in newest-first order, and no empty section.\n`,
  );
  process.exitCode = 0;
}

main();
