import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";

import {
  readToolNames,
  toolAccess,
  toolNames,
  writeToolNames,
  type ZendeskToolName,
} from "./policy.js";

// The documentation lives in the repository, two levels above the connector
// package: `plugins/zendesk-connector` sits in `plugins`, which sits in the
// repository root.
const REPOSITORY_ROOT = new URL("../../../", import.meta.url);

/**
 * Reads a file of the repository. A checkout of the connector package alone
 * has no documentation to compare the policy with, so the file is reported as
 * missing instead of failing the run.
 */
function readRepositoryFile(path: string): string | undefined {
  try {
    return readFileSync(new URL(path, REPOSITORY_ROOT), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Reads a document of the repository for a test. The test is skipped when the
 * document is not part of the checkout, and the caller stops there.
 */
function document(ctx: TestContext, path: string): string | undefined {
  const text = readRepositoryFile(path);
  if (text === undefined) {
    ctx.skip(`the repository file ${path} is not part of this checkout`);
  }
  return text;
}

/** The text of a generated section of a markdown file. */
function markdownSection(text: string, name: string): string {
  const begin = `<!-- BEGIN GENERATED: ${name} -->`;
  const end = `<!-- END GENERATED: ${name} -->`;
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  assert.ok(
    start >= 0 && stop > start,
    `the generated section '${name}' is missing`,
  );
  return text.slice(start + begin.length, stop);
}

/** The text of a generated section of the environment example. */
function environmentSection(text: string, name: string): string {
  const begin = `# BEGIN GENERATED: ${name}`;
  const end = `# END GENERATED: ${name}`;
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  assert.ok(
    start >= 0 && stop > start,
    `the generated section '${name}' is missing`,
  );
  return text.slice(start + begin.length, stop);
}

/** The tool names and their access labels of a generated tool table. */
function tableRows(section: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of section.split("\n")) {
    const match = /^\|\s*`([a-z0-9_]+)`\s*\|\s*(Read|Write)\s*\|/.exec(line);
    if (match === null) continue;
    rows.set(match[1], match[2]);
  }
  return rows;
}

/** The tool names of a generated tool list. */
function listEntries(section: string): string[] {
  const names: string[] = [];
  for (const line of section.split("\n")) {
    const match = /^-\s*`([a-z0-9_]+)`\s*:/.exec(line);
    if (match === null) continue;
    names.push(match[1]);
  }
  return names;
}

/** The tool names of a generated allowlist example. */
function allowlistNames(section: string): string[] {
  const body = section
    .split("\n")
    .filter((line) => !line.startsWith("```"))
    .map((line) => line.replace(/^#\s*/, "").replace(/\\$/, ""))
    .join("");
  const match = /export ZENDESK_ALLOWED_TOOLS="([^"]*)"/.exec(body);
  assert.ok(match !== null, "the example states no allowlist");
  return match[1].split(",");
}

/** The counts the generated sections state, read from the counts sentence. */
function statedCounts(section: string): {
  total: number;
  read: number;
  write: number;
} {
  const match = /(\d+) tools: (\d+) read tools and (\d+) write tools/.exec(section);
  assert.ok(match !== null, "the generated section states no counts");
  return {
    total: Number(match[1]),
    read: Number(match[2]),
    write: Number(match[3]),
  };
}

/** The access a table row states for a tool, as the policy classifies it. */
function expectedAccess(tool: string): string {
  return toolAccess(tool as ZendeskToolName) === "write" ? "Write" : "Read";
}

test("the tool contracts table names every tool of the policy", (ctx) => {
  const contracts = document(ctx, "docs/tool-contracts.md");
  if (contracts === undefined) return;
  const rows = tableRows(markdownSection(contracts, "tool table"));
  assert.deepEqual(
    [...rows.keys()].sort(),
    [...toolNames()].sort(),
  );
});

test("the tool contracts table marks the write tools as writes", (ctx) => {
  const contracts = document(ctx, "docs/tool-contracts.md");
  if (contracts === undefined) return;
  const rows = tableRows(markdownSection(contracts, "tool table"));
  for (const [tool, access] of rows) {
    assert.equal(access, expectedAccess(tool));
  }
  const writes = [...rows.entries()]
    .filter(([, access]) => access === "Write")
    .map(([tool]) => tool);
  assert.deepEqual(writes.sort(), [...writeToolNames()].sort());
});

test("the tool contracts table states the counts of the policy", (ctx) => {
  const contracts = document(ctx, "docs/tool-contracts.md");
  if (contracts === undefined) return;
  const counts = statedCounts(markdownSection(contracts, "tool table"));
  assert.equal(counts.total, toolNames().length);
  assert.equal(counts.read, readToolNames().length);
  assert.equal(counts.write, writeToolNames().length);
});

test("the repository README table names every tool of the policy", (ctx) => {
  const readme = document(ctx, "README.md");
  if (readme === undefined) return;
  const rows = tableRows(markdownSection(readme, "tool table"));
  assert.deepEqual([...rows.keys()].sort(), [...toolNames()].sort());
  for (const [tool, access] of rows) {
    assert.equal(access, expectedAccess(tool));
  }
});

test("the plugin README list names every tool of the policy", (ctx) => {
  const readme = document(ctx, "plugins/zendesk-connector/README.md");
  if (readme === undefined) return;
  const names = listEntries(markdownSection(readme, "tool table"));
  assert.deepEqual(names.sort(), [...toolNames()].sort());
});

test("the environment example allowlist names every read tool", (ctx) => {
  const example = document(ctx, "plugins/zendesk-connector/.env.example");
  if (example === undefined) return;
  const section = environmentSection(example, "read-only tool allowlist");
  const match = /^# ZENDESK_ALLOWED_TOOLS=(.*)$/m.exec(section);
  assert.ok(match !== null, "the environment example states no allowlist");
  assert.deepEqual(match[1].split(","), [...readToolNames()]);
});

test("the environment example names no write tool", (ctx) => {
  const example = document(ctx, "plugins/zendesk-connector/.env.example");
  if (example === undefined) return;
  const section = environmentSection(example, "read-only tool allowlist");
  const match = /^# ZENDESK_ALLOWED_TOOLS=(.*)$/m.exec(section);
  assert.ok(match !== null, "the environment example states no allowlist");
  for (const tool of writeToolNames()) {
    assert.ok(!match[1].split(",").includes(tool), `${tool} is a write tool`);
  }
});

test("the allowlist examples name every read tool", (ctx) => {
  const contracts = document(ctx, "docs/tool-contracts.md");
  if (contracts === undefined) return;
  const readme = document(ctx, "plugins/zendesk-connector/README.md");
  if (readme === undefined) return;
  const sections = [
    markdownSection(contracts, "read-only allowlist example"),
    markdownSection(readme, "read-only allowlist example"),
  ];
  for (const section of sections) {
    assert.deepEqual(allowlistNames(section), [...readToolNames()]);
  }
});
