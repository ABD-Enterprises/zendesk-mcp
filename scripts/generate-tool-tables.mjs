// Generates the tool tables and the read-only allowlist from the connector's
// tool policy.
//
// Usage:
//   node scripts/generate-tool-tables.mjs --check   verify that the committed
//                                                    sections match the policy
//   node scripts/generate-tool-tables.mjs --write   rewrite them in place
//
// The script has no dependencies and needs Node.js 20 or newer.
//
// The source of truth is `plugins/zendesk-connector/src/policy.ts`: its
// `ALL_TOOLS` list names every tool and its `WRITE_TOOLS` list says which of
// them write. The tool names and the read/write classification are read from
// there, so a tool that is added, renamed or removed in the policy is picked
// up by the generated sections, and a policy that drifts away from the
// committed documentation fails the check.
//
// The generated sections are marked with `BEGIN GENERATED` / `END GENERATED`
// markers, and the text around them stays hand-written. `TOOL_DETAILS` below
// holds the human-readable summary of each tool; it is not a second list of
// tool names, and the script refuses to run when it does not cover exactly
// the tools the policy names.
//
// A violation is printed on its own line to stderr and the script exits
// non-zero; a clean tree prints one OK line to stdout and exits zero.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");

const POLICY_PATH = path.join(
  REPOSITORY_ROOT,
  "plugins",
  "zendesk-connector",
  "src",
  "policy.ts",
);

/** The tool names the policy may hold. */
const TOOL_NAME_PATTERN = /^zendesk_[a-z0-9_]+$/;

/** The width a generated allowlist line may take, backslash included. */
const ALLOWLIST_LINE_WIDTH = 70;

/**
 * The hand-written summary of every tool: one line of purpose, and the
 * inputs column of the tool contracts reference. The keys must be exactly the
 * tools the policy names, in any order; the script fails when they differ.
 */
const TOOL_DETAILS = {
  zendesk_status: {
    summary: "Verify OAuth and identify the authenticated user",
    inputs: "None",
  },
  zendesk_search_tickets: {
    summary: "Search Zendesk with Zendesk search syntax",
    inputs:
      "`query` string (required); `page` int (default 1); `perPage` int (default 25, max 100)",
  },
  zendesk_get_ticket: {
    summary: "Read a ticket with users, organization, and comments",
    inputs:
      "`ticketId` int (required); `includeComments` bool (default true); `commentPage` int (default 1)",
  },
  zendesk_create_ticket: {
    summary: "Create a ticket",
    inputs:
      "`subject` string (required); `comment` string (required); `public` bool (default true); " +
      "`requesterEmail` valid email (optional); `requesterName` string (optional); " +
      "`priority` enum: urgent, high, normal, low (optional); " +
      "`status` enum: new, open, pending, hold, solved, closed (optional); " +
      "`type` enum: problem, incident, question, task (optional); " +
      "`tags` array of non-empty strings (optional)",
  },
  zendesk_update_ticket: {
    summary: "Update common ticket fields",
    inputs:
      "`ticketId` int (required); `subject` string (optional); " +
      "`priority`, `status`, `type` enums as in create (optional); " +
      "`tags` array of at least one non-empty string (optional); " +
      "at least one update field required",
  },
  zendesk_add_ticket_comment: {
    summary: "Add an internal note or public reply",
    inputs:
      "`ticketId` int (required); `body` string (required); `public` bool (default false)",
  },
  zendesk_list_brands: {
    summary: "List brands with page-based pagination",
    inputs: "`page` int (default 1); `perPage` int (default 25, max 100)",
  },
  zendesk_list_groups: {
    summary: "List groups with page-based pagination",
    inputs: "`page` int (default 1); `perPage` int (default 25, max 100)",
  },
  zendesk_list_users: {
    summary: "List users with page-based pagination",
    inputs: "`page` int (default 1); `perPage` int (default 25, max 100)",
  },
  zendesk_get_user: {
    summary: "Read one user by id",
    inputs: "`userId` int (required)",
  },
  zendesk_list_organizations: {
    summary: "List organizations with page-based pagination",
    inputs: "`page` int (default 1); `perPage` int (default 25, max 100)",
  },
  zendesk_get_organization: {
    summary: "Read one organization by id",
    inputs: "`organizationId` int (required)",
  },
  zendesk_list_ticket_fields: {
    summary: "List all ticket fields (one unpaginated response)",
    inputs: "None",
  },
  zendesk_list_ticket_forms: {
    summary: "List ticket forms with page-based pagination",
    inputs: "`page` int (default 1); `perPage` int (default 25, max 100)",
  },
  zendesk_list_views: {
    summary:
      "List the shared and personal ticket views the authenticated user can see, with page-based pagination",
    inputs: "`page` int (default 1); `perPage` int (default 25, max 100)",
  },
  zendesk_list_view_tickets: {
    summary: "List the tickets in one view, with page-based pagination",
    inputs:
      "`viewId` int (required); `page` int (default 1); `perPage` int (default 25, max 100)",
  },
  zendesk_get_view: {
    summary: "Read one view by id",
    inputs: "`viewId` int (required)",
  },
};

// --- Reading the tool policy ------------------------------------------------

/** Skips whitespace and comments, and returns the index of the first code. */
function skipTrivia(source, index) {
  let cursor = index;
  while (cursor < source.length) {
    const character = source[cursor];
    if (/\s/.test(character)) {
      cursor += 1;
      continue;
    }
    if (source.startsWith("//", cursor)) {
      const end = source.indexOf("\n", cursor);
      cursor = end === -1 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith("/*", cursor)) {
      const end = source.indexOf("*/", cursor + 2);
      if (end === -1) {
        throw new Error("the tool policy holds an unterminated block comment");
      }
      cursor = end + 2;
      continue;
    }
    break;
  }
  return cursor;
}

/**
 * Reads the string literals of the array a `const` declaration holds. The
 * declaration has to be a plain array of string literals; anything else is
 * refused, so a policy that stops being a plain list fails loudly instead of
 * silently generating the wrong documentation.
 */
function readDeclaredArray(source, name) {
  const declaration = new RegExp(
    `(?:export\\s+)?const\\s+${name}\\b([^=]*)=`,
    "g",
  );
  const match = declaration.exec(source);
  if (!match) {
    throw new Error(`the tool policy does not declare \`const ${name}\``);
  }
  const annotation = match[1].trim();
  if (annotation !== "") {
    throw new Error(
      `the tool policy declares \`${name}\` with an unsupported type: ${annotation}`,
    );
  }

  let cursor = match.index + match[0].length;
  cursor = skipTrivia(source, cursor);
  if (source[cursor] !== "[") {
    throw new Error(
      `the tool policy declares \`${name}\` as something other than an array of names`,
    );
  }
  cursor += 1;

  const names = [];
  for (;;) {
    cursor = skipTrivia(source, cursor);
    if (source[cursor] === "]") {
      cursor += 1;
      break;
    }
    const quote = source[cursor];
    if (quote !== '"' && quote !== "'") {
      throw new Error(
        `the tool policy declares \`${name}\` with an entry that is not a string literal`,
      );
    }
    const end = source.indexOf(quote, cursor + 1);
    if (end === -1) {
      throw new Error(
        `the tool policy declares \`${name}\` with an unterminated string literal`,
      );
    }
    names.push(source.slice(cursor + 1, end));
    cursor = end + 1;
    cursor = skipTrivia(source, cursor);
    if (source[cursor] === ",") {
      cursor += 1;
      continue;
    }
    if (source[cursor] === "]") {
      cursor += 1;
      break;
    }
    throw new Error(
      `the tool policy declares \`${name}\` with an entry that is not a string literal`,
    );
  }
  return names;
}

/**
 * Reads the tool names and the write-tool names from the policy source.
 */
export function parsePolicy(source) {
  const tools = readDeclaredArray(source, "ALL_TOOLS");
  const writeTools = readDeclaredArray(source, "WRITE_TOOLS");

  if (tools.length === 0) {
    throw new Error("the tool policy names no tools");
  }
  for (const tool of tools) {
    if (!TOOL_NAME_PATTERN.test(tool)) {
      throw new Error(`the tool policy names an unexpected tool: ${tool}`);
    }
  }
  for (const [list, label] of [
    [tools, "ALL_TOOLS"],
    [writeTools, "WRITE_TOOLS"],
  ]) {
    const seen = new Set();
    for (const tool of list) {
      if (seen.has(tool)) {
        throw new Error(`the tool policy names ${tool} twice in ${label}`);
      }
      seen.add(tool);
    }
  }
  for (const tool of writeTools) {
    if (!tools.includes(tool)) {
      throw new Error(
        `the tool policy names ${tool} as a write tool, but it is not one of the tools`,
      );
    }
  }
  return { tools, writeTools };
}

/** Reads the tool policy from the connector source. */
export function readPolicy(policyPath = POLICY_PATH) {
  return parsePolicy(readFileSync(policyPath, "utf8"));
}

// --- The manifest -----------------------------------------------------------

/**
 * Builds the manifest the documentation is generated from: the tool names
 * and their access come from the policy, the summaries from `TOOL_DETAILS`.
 *
 * The summaries are a parameter so that the self-tests can exercise the
 * coverage rules with a small policy; the script itself always passes the
 * summaries it holds.
 */
export function buildManifest(policy, details = TOOL_DETAILS) {
  const writeSet = new Set(policy.writeTools);
  const read = policy.tools.filter((tool) => !writeSet.has(tool));
  const write = policy.tools.filter((tool) => writeSet.has(tool));

  const missing = policy.tools.filter((tool) => !(tool in details));
  if (missing.length > 0) {
    throw new Error(
      `the tool policy names ${missing.join(", ")}, which the generator has no summary for`,
    );
  }
  const unknown = Object.keys(details).filter(
    (tool) => !policy.tools.includes(tool),
  );
  if (unknown.length > 0) {
    throw new Error(
      `the generator has a summary for ${unknown.join(", ")}, which the tool policy does not name`,
    );
  }

  return {
    tools: policy.tools,
    read,
    write,
    details,
    counts: {
      total: policy.tools.length,
      read: read.length,
      write: write.length,
    },
  };
}

// --- Rendering --------------------------------------------------------------

/** The tools in the order the documentation lists them: reads, then writes. */
function orderedTools(manifest) {
  return [...manifest.read, ...manifest.write];
}

function accessLabel(manifest, tool) {
  return manifest.write.includes(tool) ? "Write" : "Read";
}

/** The sentence that states how many tools there are. */
function renderCounts(manifest) {
  return (
    `The connector ships ${manifest.counts.total} tools: ` +
    `${manifest.counts.read} read tools and ${manifest.counts.write} write tools.`
  );
}

/** The tool table of the tool contracts reference. */
function renderContractsTable(manifest) {
  const rows = orderedTools(manifest).map((tool) => {
    const details = manifest.details[tool];
    return (
      `| \`${tool}\` | ${accessLabel(manifest, tool)} | ${details.summary} | ` +
      `${details.inputs} | Yes |`
    );
  });
  return [
    "| Tool | Access | Purpose | Inputs (types and defaults) | Audit |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/** The tool table of the repository README. */
function renderSummaryTable(manifest) {
  const rows = orderedTools(manifest).map((tool) => {
    const details = manifest.details[tool];
    return `| \`${tool}\` | ${accessLabel(manifest, tool)} | ${details.summary} |`;
  });
  return [
    "| Tool | Access | Purpose |",
    "| --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/** The tool list of the plugin README. */
function renderToolList(manifest) {
  return orderedTools(manifest)
    .map((tool) => {
      const summary = manifest.details[tool].summary;
      const sentence = `${summary[0].toLowerCase()}${summary.slice(1)}`;
      return `- \`${tool}\`: ${sentence}.`;
    })
    .join("\n");
}

/**
 * Wraps a list of tool names into the lines of a shell assignment. Every line
 * but the last ends with a backslash; the last one closes the quote.
 */
export function wrapAllowlist(names, options = {}) {
  const {
    firstPrefix = "",
    linePrefix = "",
    width = ALLOWLIST_LINE_WIDTH,
  } = options;
  const segments = names.map((name, index) =>
    index === names.length - 1 ? name : `${name},`,
  );
  const lines = [];
  let prefix = `${linePrefix}${firstPrefix}`;
  let content = "";
  for (const [index, segment] of segments.entries()) {
    const isLast = index === segments.length - 1;
    const candidate = content + segment;
    const length = prefix.length + candidate.length + 1;
    if (content !== "" && length > width) {
      lines.push(`${prefix}${content}\\`);
      prefix = linePrefix;
      content = "";
    }
    content += segment;
  }
  lines.push(`${prefix}${content}"`);
  return lines;
}

/** The read-only allowlist example of the tool contracts reference. */
function renderAllowlistExample(manifest) {
  const lines = wrapAllowlist(manifest.read, {
    firstPrefix: 'export ZENDESK_ALLOWED_TOOLS="',
  });
  return ["```sh", ...lines, "```"].join("\n");
}

/** The read-only allowlist example of the plugin README. */
function renderPluginAllowlistExample(manifest) {
  const lines = wrapAllowlist(manifest.read, {
    firstPrefix: 'export ZENDESK_ALLOWED_TOOLS="',
    linePrefix: "# ",
  });
  return [
    "```sh",
    "export ZENDESK_READ_ONLY=1",
    "# Or, instead, name the read tools explicitly:",
    ...lines,
    "```",
  ].join("\n");
}

/** The read-only allowlist of the environment example. */
function renderEnvironmentAllowlist(manifest) {
  return [
    `# ZENDESK_ALLOWED_TOOLS=${manifest.read.join(",")}`,
    `# Simpler alternative: serve only the ${manifest.counts.read} read tools:`,
    "# ZENDESK_READ_ONLY=1",
  ].join("\n");
}

// --- The generated sections -------------------------------------------------

const TARGETS = [
  {
    path: "docs/tool-contracts.md",
    style: "html",
    blocks: [
      {
        name: "tool table",
        render: (manifest) =>
          [renderCounts(manifest), "", renderContractsTable(manifest)].join("\n"),
      },
      { name: "read-only allowlist example", render: renderAllowlistExample },
    ],
  },
  {
    path: "README.md",
    style: "html",
    blocks: [
      {
        name: "tool table",
        render: (manifest) =>
          [renderCounts(manifest), "", renderSummaryTable(manifest)].join("\n"),
      },
    ],
  },
  {
    path: "plugins/zendesk-connector/README.md",
    style: "html",
    blocks: [
      {
        name: "tool table",
        render: (manifest) =>
          [renderCounts(manifest), "", renderToolList(manifest)].join("\n"),
      },
      {
        name: "read-only allowlist example",
        render: renderPluginAllowlistExample,
      },
    ],
  },
  {
    path: "plugins/zendesk-connector/.env.example",
    style: "hash",
    blocks: [
      { name: "read-only tool allowlist", render: renderEnvironmentAllowlist },
    ],
  },
];

/** The marker lines that open and close a generated section. */
export function markers(style, name) {
  if (style === "html") {
    return {
      begin: `<!-- BEGIN GENERATED: ${name} -->`,
      end: `<!-- END GENERATED: ${name} -->`,
    };
  }
  if (style === "hash") {
    return {
      begin: `# BEGIN GENERATED: ${name}`,
      end: `# END GENERATED: ${name}`,
    };
  }
  throw new Error(`unknown marker style: ${style}`);
}

/** The index just after the line that holds `index`. */
function afterLine(text, index) {
  const newline = text.indexOf("\n", index);
  return newline === -1 ? text.length : newline + 1;
}

/** The index just before the line that starts at `index`. */
function beforeLine(text, index) {
  let end = index;
  while (end > 0 && (text[end - 1] === "\n" || text[end - 1] === "\r")) {
    end -= 1;
  }
  return end;
}

/**
 * Finds the generated sections of a file. Every marker has to be paired with
 * the marker of the same name, and no section may hold another one.
 *
 * The body of a section is the text between the two marker lines: it starts
 * after the newline that ends the opening marker and stops before the
 * newline that precedes the closing marker, so it holds the generated text
 * and nothing else.
 */
export function findSections(text, style) {
  const pattern =
    style === "html"
      ? /^<!-- (BEGIN|END) GENERATED: (.+?) -->\r?$/gm
      : /^# (BEGIN|END) GENERATED: (.+)$/gm;
  const markersFound = [];
  for (const match of text.matchAll(pattern)) {
    markersFound.push({
      kind: match[1] === "BEGIN" ? "begin" : "end",
      name: match[2].trim(),
      index: match.index,
      length: match[0].length,
    });
  }

  const sections = [];
  const problems = [];
  const open = [];
  for (const marker of markersFound) {
    if (marker.kind === "begin") {
      if (open.some((entry) => entry.name === marker.name)) {
        problems.push(
          `the generated section '${marker.name}' is opened twice`,
        );
        continue;
      }
      open.push(marker);
      continue;
    }
    const index = open.findIndex((entry) => entry.name === marker.name);
    if (index === -1) {
      problems.push(
        `the generated section '${marker.name}' is closed without being opened`,
      );
      continue;
    }
    const [begin] = open.splice(index, 1);
    sections.push({
      name: begin.name,
      bodyStart: afterLine(text, begin.index + begin.length),
      bodyEnd: beforeLine(text, marker.index),
      beginStart: begin.index,
      endEnd: marker.index + marker.length,
    });
  }
  for (const entry of open) {
    problems.push(`the generated section '${entry.name}' is never closed`);
  }
  sections.sort((left, right) => left.beginStart - right.beginStart);
  return { sections, problems };
}

/**
 * Compares the generated sections of a file with what the manifest renders.
 * The returned text carries the rendered sections.
 */
export function applySections(text, style, blocks, manifest) {
  const { sections, problems } = findSections(text, style);
  const violations = [...problems];
  const known = new Map(blocks.map((block) => [block.name, block]));
  const replacements = [];

  for (const section of sections) {
    const block = known.get(section.name);
    if (!block) {
      violations.push(
        `the generated section '${section.name}' is not one this script writes`,
      );
      continue;
    }
    const expected = block.render(manifest);
    const current = text.slice(section.bodyStart, section.bodyEnd);
    if (current !== expected) {
      violations.push(
        `the generated section '${section.name}' does not match the tool policy; run 'node scripts/generate-tool-tables.mjs --write'`,
      );
      replacements.push({
        start: section.bodyStart,
        end: section.bodyEnd,
        expected,
      });
    }
  }

  for (const block of blocks) {
    if (!sections.some((section) => section.name === block.name)) {
      violations.push(
        `the generated section '${block.name}' is missing; add its markers`,
      );
    }
  }

  // The replacements are applied from the end of the file backwards, so that
  // the offsets of the sections that come earlier stay valid.
  let updated = text;
  for (const replacement of replacements.sort(
    (left, right) => right.start - left.start,
  )) {
    updated =
      updated.slice(0, replacement.start) +
      replacement.expected +
      updated.slice(replacement.end);
  }

  return { text: updated, violations };
}

// --- The command line -------------------------------------------------------

/** Checks every target and returns the violations it found. */
export function checkTargets(
  manifest,
  targets = TARGETS,
  baseDirectory = REPOSITORY_ROOT,
) {
  const violations = [];
  for (const target of targets) {
    const filePath = path.join(baseDirectory, target.path);
    let text;
    try {
      text = readFileSync(filePath, "utf8");
    } catch (error) {
      violations.push(`${target.path}: cannot read the file: ${error.message}`);
      continue;
    }
    const result = applySections(text, target.style, target.blocks, manifest);
    for (const violation of result.violations) {
      violations.push(`${target.path}: ${violation}`);
    }
  }
  return violations;
}

/** Rewrites every target and returns the paths that changed. */
export function writeTargets(
  manifest,
  targets = TARGETS,
  baseDirectory = REPOSITORY_ROOT,
) {
  const changed = [];
  const violations = [];
  for (const target of targets) {
    const filePath = path.join(baseDirectory, target.path);
    let text;
    try {
      text = readFileSync(filePath, "utf8");
    } catch (error) {
      violations.push(`${target.path}: cannot read the file: ${error.message}`);
      continue;
    }
    const result = applySections(text, target.style, target.blocks, manifest);
    // A section that drifted away from the policy is what the rewrite fixes.
    // Every other problem — a missing marker, a section this script does not
    // write — is reported and left alone, so a broken file is never rewritten
    // into a different broken file.
    const structural = result.violations.filter(
      (violation) => !violation.includes("does not match the tool policy"),
    );
    for (const violation of structural) {
      violations.push(`${target.path}: ${violation}`);
    }
    if (structural.length > 0) continue;
    if (result.text !== text) {
      writeFileSync(filePath, result.text);
      changed.push(target.path);
    }
  }
  return { changed, violations };
}

function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((argument) => !["--check", "--write"].includes(argument));
  if (unknown.length > 0) {
    process.stderr.write(
      `unknown option(s): ${unknown.join(", ")}; usage: node scripts/generate-tool-tables.mjs --check | --write\n`,
    );
    process.exitCode = 1;
    return;
  }

  let manifest;
  try {
    manifest = buildManifest(readPolicy());
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (args.includes("--write")) {
    const { changed, violations } = writeTargets(manifest);
    for (const violation of violations) {
      process.stderr.write(`${violation}\n`);
    }
    if (violations.length > 0) {
      process.exitCode = 1;
      return;
    }
    if (changed.length === 0) {
      process.stdout.write("OK: the generated tool tables already match.\n");
    } else {
      process.stdout.write(
        `Wrote the generated tool tables in ${changed.join(", ")}.\n`,
      );
    }
    return;
  }

  const violations = checkTargets(manifest);
  if (violations.length > 0) {
    for (const violation of violations) {
      process.stderr.write(`${violation}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `OK: the generated tool tables match the tool policy (${manifest.counts.total} tools, ` +
      `${manifest.counts.read} read, ${manifest.counts.write} write).\n`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
