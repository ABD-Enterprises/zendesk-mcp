// Self-tests for the tool-table generator.
//
// Usage:
//   node --test scripts/generate-tool-tables.test.mjs
//
// The tests cover the policy parser, the manifest, the rendering, the marker
// engine and the drift check. They need no network access, no account and no
// credentials: the only files they read are the repository's own sources and
// documentation.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  applySections,
  buildManifest,
  checkTargets,
  findSections,
  markers,
  parsePolicy,
  readPolicy,
  wrapAllowlist,
  writeTargets,
} from "./generate-tool-tables.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const SCRIPT_PATH = path.join(SCRIPT_DIRECTORY, "generate-tool-tables.mjs");

/** A policy with two tools, one of them a write tool. */
const POLICY_SOURCE = `
export const ALL_TOOLS = [
  "zendesk_status",
  "zendesk_create_ticket",
] as const;

export const WRITE_TOOLS = [
  "zendesk_create_ticket",
] as const;
`;

/**
 * The summaries the fixture policy needs. The generator holds the summaries of
 * the real tools; a fixture policy is given its own, so that the coverage
 * rules can be exercised without naming all fourteen tools.
 */
const FIXTURE_DETAILS = {
  zendesk_status: {
    summary: "Verify OAuth and identify the authenticated user",
    inputs: "None",
  },
  zendesk_create_ticket: {
    summary: "Create a ticket",
    inputs: "`subject` string (required)",
  },
};

/** Builds the manifest of the fixture policy. */
function fixtureManifest() {
  return buildManifest(parsePolicy(POLICY_SOURCE), FIXTURE_DETAILS);
}

/** Builds a policy source that names the given tools and write tools. */
function policySource(tools, writeTools = []) {
  const list = (names) =>
    names.map((name) => `  "${name}",`).join("\n");
  return [
    "export const ALL_TOOLS = [",
    list(tools),
    "] as const;",
    "",
    "export const WRITE_TOOLS = [",
    list(writeTools),
    "] as const;",
    "",
  ].join("\n");
}

// --- The policy parser -------------------------------------------------------

test("reads the tool names and the write tools from the policy", () => {
  const policy = parsePolicy(POLICY_SOURCE);
  assert.deepEqual(policy.tools, ["zendesk_status", "zendesk_create_ticket"]);
  assert.deepEqual(policy.writeTools, ["zendesk_create_ticket"]);
});

test("reads a policy whose lists hold comments and blank lines", () => {
  const source = [
    "export const ALL_TOOLS = [",
    "  // the first tool",
    "  \"zendesk_status\",",
    "",
    "  \"zendesk_search_tickets\",",
    "] as const;",
    "",
    "export const WRITE_TOOLS = [",
    "] as const;",
    "",
  ].join("\n");
  const policy = parsePolicy(source);
  assert.deepEqual(policy.tools, [
    "zendesk_status",
    "zendesk_search_tickets",
  ]);
  assert.deepEqual(policy.writeTools, []);
});

test("refuses a policy that does not declare the tool list", () => {
  assert.throws(
    () => parsePolicy("export const WRITE_TOOLS = [] as const;\n"),
    /does not declare `const ALL_TOOLS`/,
  );
});

test("refuses a policy whose tool list is not an array of names", () => {
  assert.throws(
    () => parsePolicy("export const ALL_TOOLS = makeTools();\n"),
    /something other than an array of names/,
  );
});

test("refuses a policy whose tool list holds a value that is not a name", () => {
  assert.throws(
    () => parsePolicy("export const ALL_TOOLS = [ALLOWED];\n"),
    /not a string literal/,
  );
});

test("refuses a policy that names the same tool twice", () => {
  assert.throws(
    () =>
      parsePolicy(
        policySource(["zendesk_status", "zendesk_status"], []),
      ),
    /names zendesk_status twice/,
  );
});

test("refuses a policy that calls an unknown tool a write tool", () => {
  assert.throws(
    () =>
      parsePolicy(
        policySource(["zendesk_status"], ["zendesk_create_ticket"]),
      ),
    /not one of the tools/,
  );
});

test("refuses a tool name that is not a tool name", () => {
  assert.throws(
    () => parsePolicy(policySource(["status"], [])),
    /names an unexpected tool: status/,
  );
});

test("refuses a policy that names no tools", () => {
  assert.throws(
    () => parsePolicy(policySource([], [])),
    /names no tools/,
  );
});

test("refuses a policy that declares the tool list with an unsupported type", () => {
  const source = "export const ALL_TOOLS: readonly string[] = [];\n";
  assert.throws(
    () => parsePolicy(source),
    /unsupported type/,
  );
});

test("refuses a policy that declares the tool list as a set", () => {
  const source = [
    "export const ALL_TOOLS: ReadonlySet<string> = new Set([",
    '  "zendesk_status",',
    "]);",
    "",
  ].join("\n");
  assert.throws(
    () => parsePolicy(source),
    /unsupported type/,
  );
});

test("refuses a policy whose tool list is wrapped in a set", () => {
  const source = [
    "export const ALL_TOOLS = new Set([",
    '  "zendesk_status",',
    "]);",
    "",
  ].join("\n");
  assert.throws(
    () => parsePolicy(source),
    /something other than an array of names/,
  );
});

test("reads the connector's own policy", () => {
  const policy = readPolicy();
  assert.ok(policy.tools.length > 0);
  for (const tool of policy.writeTools) {
    assert.ok(policy.tools.includes(tool), `${tool} is not one of the tools`);
  }
});

// --- The manifest ------------------------------------------------------------

test("keeps the read tools and the write tools apart", () => {
  const manifest = fixtureManifest();
  assert.deepEqual(manifest.read, ["zendesk_status"]);
  assert.deepEqual(manifest.write, ["zendesk_create_ticket"]);
});

test("counts the tools", () => {
  const policy = readPolicy();
  const manifest = buildManifest(policy);
  assert.equal(manifest.counts.total, policy.tools.length);
  assert.equal(manifest.counts.read, manifest.read.length);
  assert.equal(manifest.counts.write, manifest.write.length);
  assert.equal(
    manifest.counts.total,
    manifest.counts.read + manifest.counts.write,
  );
});

test("refuses a tool the generator has no summary for", () => {
  const policy = parsePolicy(
    policySource(["zendesk_status", "zendesk_new_thing"], []),
  );
  assert.throws(
    () => buildManifest(policy, FIXTURE_DETAILS),
    /zendesk_new_thing, which the generator has no summary for/,
  );
});

test("refuses a summary for a tool the policy does not name", () => {
  const policy = parsePolicy(policySource(["zendesk_status"], []));
  assert.throws(
    () => buildManifest(policy, FIXTURE_DETAILS),
    /which the tool policy does not name/,
  );
});

// --- The allowlist wrapping --------------------------------------------------

test("wraps the allowlist into lines that end with a backslash", () => {
  const names = ["zendesk_status", "zendesk_search_tickets", "zendesk_get_ticket"];
  const lines = wrapAllowlist(names, {
    firstPrefix: 'export ZENDESK_ALLOWED_TOOLS="',
  });
  assert.equal(lines.length, 2);
  assert.equal(
    lines[0],
    'export ZENDESK_ALLOWED_TOOLS="zendesk_status,zendesk_search_tickets,\\',
  );
  assert.equal(lines[1], 'zendesk_get_ticket"');
});

test("wraps the allowlist over several lines when it is too long", () => {
  const names = ["zendesk_status", "zendesk_search_tickets", "zendesk_get_ticket"];
  const lines = wrapAllowlist(names, {
    firstPrefix: 'export ZENDESK_ALLOWED_TOOLS="',
    width: 40,
  });
  assert.equal(lines.length, 3);
  assert.ok(lines[0].endsWith("\\"));
  assert.ok(lines[1].endsWith("\\"));
  assert.ok(!lines[2].endsWith("\\"));
  assert.ok(lines[2].endsWith('"'));
});

test("keeps every wrapped allowlist line within the width", () => {
  const manifest = buildManifest(readPolicy());
  const lines = wrapAllowlist(manifest.read, {
    firstPrefix: 'export ZENDESK_ALLOWED_TOOLS="',
  });
  for (const line of lines) {
    assert.ok(line.length <= 70, `too long: ${line}`);
  }
});

test("the wrapped allowlist holds every read tool and no other name", () => {
  const manifest = buildManifest(readPolicy());
  const lines = wrapAllowlist(manifest.read, {
    firstPrefix: 'export ZENDESK_ALLOWED_TOOLS="',
  });
  const joined = lines
    .map((line, index) =>
      index === lines.length - 1 ? line : line.replace(/\\$/, ""),
    )
    .join("");
  const value = joined
    .replace(/^export ZENDESK_ALLOWED_TOOLS="/, "")
    .replace(/"$/, "");
  assert.deepEqual(value.split(","), manifest.read);
});

// --- The marker engine -------------------------------------------------------

test("pairs the markers of a section", () => {
  const text = [
    "before",
    "<!-- BEGIN GENERATED: tool table -->",
    "body",
    "<!-- END GENERATED: tool table -->",
    "after",
    "",
  ].join("\n");
  const { sections, problems } = findSections(text, "html");
  assert.deepEqual(problems, []);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, "tool table");
  assert.equal(text.slice(sections[0].bodyStart, sections[0].bodyEnd), "body");
});

test("pairs the hash markers of a section", () => {
  const text = [
    "# BEGIN GENERATED: read-only tool allowlist",
    "# ZENDESK_ALLOWED_TOOLS=zendesk_status",
    "# END GENERATED: read-only tool allowlist",
    "",
  ].join("\n");
  const { sections, problems } = findSections(text, "hash");
  assert.deepEqual(problems, []);
  assert.equal(sections.length, 1);
  assert.equal(
    text.slice(sections[0].bodyStart, sections[0].bodyEnd),
    "# ZENDESK_ALLOWED_TOOLS=zendesk_status",
  );
});

test("reports a section that is opened twice", () => {
  const text = [
    "<!-- BEGIN GENERATED: tool table -->",
    "<!-- BEGIN GENERATED: tool table -->",
    "<!-- END GENERATED: tool table -->",
    "",
  ].join("\n");
  const { problems } = findSections(text, "html");
  assert.ok(
    problems.some((problem) => problem.includes("is opened twice")),
    problems.join(" | "),
  );
});

test("reports a section that is closed without being opened", () => {
  const text = "<!-- END GENERATED: tool table -->\n";
  const { problems } = findSections(text, "html");
  assert.ok(
    problems.some((problem) => problem.includes("closed without being opened")),
    problems.join(" | "),
  );
});

test("reports a section that is never closed", () => {
  const text = "<!-- BEGIN GENERATED: tool table -->\nbody\n";
  const { problems } = findSections(text, "html");
  assert.ok(
    problems.some((problem) => problem.includes("is never closed")),
    problems.join(" | "),
  );
});

test("builds the markers of both styles", () => {
  assert.deepEqual(markers("html", "tool table"), {
    begin: "<!-- BEGIN GENERATED: tool table -->",
    end: "<!-- END GENERATED: tool table -->",
  });
  assert.deepEqual(markers("hash", "read-only tool allowlist"), {
    begin: "# BEGIN GENERATED: read-only tool allowlist",
    end: "# END GENERATED: read-only tool allowlist",
  });
  assert.throws(() => markers("yaml", "tool table"), /unknown marker style/);
});

// --- The drift check ---------------------------------------------------------

const BLOCKS = [
  { name: "tool table", render: (manifest) => manifest.tools.join(",") },
];

/** A document with one generated section, filled with the given body. */
function document(body) {
  return [
    "before",
    "<!-- BEGIN GENERATED: tool table -->",
    body,
    "<!-- END GENERATED: tool table -->",
    "after",
    "",
  ].join("\n");
}

test("reports a section whose body drifted away from the policy", () => {
  const manifest = fixtureManifest();
  const { violations } = applySections(
    document("zendesk_status"),
    "html",
    BLOCKS,
    manifest,
  );
  assert.equal(violations.length, 1);
  assert.ok(violations[0].includes("does not match the tool policy"));
});

test("reports a section whose markers are missing", () => {
  const manifest = fixtureManifest();
  const { violations } = applySections(
    "before\nafter\n",
    "html",
    BLOCKS,
    manifest,
  );
  assert.equal(violations.length, 1);
  assert.ok(violations[0].includes("is missing"));
});

test("reports a section this script does not write", () => {
  const manifest = fixtureManifest();
  const { violations } = applySections(
    [
      "<!-- BEGIN GENERATED: something else -->",
      "body",
      "<!-- END GENERATED: something else -->",
      "",
    ].join("\n"),
    "html",
    BLOCKS,
    manifest,
  );
  assert.equal(violations.length, 2);
  assert.ok(violations[0].includes("is not one this script writes"));
  assert.ok(violations[1].includes("is missing"));
});

test("accepts a section that matches the policy", () => {
  const manifest = fixtureManifest();
  const body = manifest.tools.join(",");
  const { violations, text } = applySections(
    document(body),
    "html",
    BLOCKS,
    manifest,
  );
  assert.deepEqual(violations, []);
  assert.equal(text, document(body));
});

test("rewrites a stale section and then accepts it", () => {
  const manifest = fixtureManifest();
  const stale = document("zendesk_status");
  const written = applySections(stale, "html", BLOCKS, manifest);
  assert.equal(written.violations.length, 1);
  assert.ok(written.text.includes(manifest.tools.join(",")));
  const checked = applySections(written.text, "html", BLOCKS, manifest);
  assert.deepEqual(checked.violations, []);
});

test("rewrites every section of a document that holds several", () => {
  const manifest = fixtureManifest();
  const blocks = [
    { name: "first", render: (value) => value.tools.join(",") },
    { name: "second", render: (value) => value.write.join(",") },
  ];
  const stale = [
    "<!-- BEGIN GENERATED: first -->",
    "stale",
    "<!-- END GENERATED: first -->",
    "between",
    "<!-- BEGIN GENERATED: second -->",
    "stale",
    "<!-- END GENERATED: second -->",
    "",
  ].join("\n");
  const written = applySections(stale, "html", blocks, manifest);
  assert.equal(written.violations.length, 2);
  const expected = [
    "<!-- BEGIN GENERATED: first -->",
    manifest.tools.join(","),
    "<!-- END GENERATED: first -->",
    "between",
    "<!-- BEGIN GENERATED: second -->",
    manifest.write.join(","),
    "<!-- END GENERATED: second -->",
    "",
  ].join("\n");
  assert.equal(written.text, expected);
  const checked = applySections(written.text, "html", blocks, manifest);
  assert.deepEqual(checked.violations, []);
});

// --- The rewrite -------------------------------------------------------------

/** Creates a directory the rewrite tests write their files in. */
function temporaryDirectory() {
  return mkdtempSync(path.join(tmpdir(), "tool-tables-"));
}

test("the rewrite repairs a section that drifted away from the policy", () => {
  const directory = temporaryDirectory();
  try {
    const manifest = fixtureManifest();
    const target = { path: "stale.md", style: "html", blocks: BLOCKS };
    writeFileSync(path.join(directory, target.path), document("stale"));
    const { changed, violations } = writeTargets(manifest, [target], directory);
    assert.deepEqual(violations, []);
    assert.deepEqual(changed, ["stale.md"]);
    const written = readFileSync(path.join(directory, target.path), "utf8");
    assert.ok(written.includes(manifest.tools.join(",")));
    assert.deepEqual(checkTargets(manifest, [target], directory), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the rewrite reports a missing section and leaves the file alone", () => {
  const directory = temporaryDirectory();
  try {
    const manifest = fixtureManifest();
    const target = { path: "broken.md", style: "html", blocks: BLOCKS };
    const text = "before\nafter\n";
    writeFileSync(path.join(directory, target.path), text);
    const { changed, violations } = writeTargets(manifest, [target], directory);
    assert.deepEqual(changed, []);
    assert.equal(violations.length, 1);
    assert.ok(violations[0].includes("is missing"));
    assert.equal(readFileSync(path.join(directory, target.path), "utf8"), text);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// --- The committed documentation ---------------------------------------------

test("the committed documentation matches the tool policy", () => {
  const manifest = buildManifest(readPolicy());
  const violations = checkTargets(manifest);
  assert.deepEqual(violations, []);
});

// --- The command line --------------------------------------------------------

test("the check exits zero on the committed tree", () => {
  const result = spawnSync("node", [SCRIPT_PATH, "--check"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK: the generated tool tables match/);
});

test("the check refuses an unknown option", () => {
  const result = spawnSync("node", [SCRIPT_PATH, "--rewrite"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown option/);
});
