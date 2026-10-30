#!/usr/bin/env node
/**
 * End-to-end harness for the Zendesk MCP connector.
 *
 * Spawns the built server (`dist/index.js`) as a child process and speaks MCP
 * over its stdio (newline-delimited JSON-RPC), asserting real request to
 * response behavior for the read-only tools. Configuration comes only from
 * the environment:
 *
 *   ZENDESK_OAUTH_ACCESS_TOKEN  required; selects access-token mode
 *   ZENDESK_BASE_URL            sandbox API base URL (http allowed for
 *                               localhost only, as the server validates)
 *   ZENDESK_SUBDOMAIN           alternative to ZENDESK_BASE_URL
 *   ZENDESK_E2E_TICKET_ID       optional; when set, zendesk_get_ticket also
 *                               runs against this ticket
 *
 * When the sandbox variables are not configured the harness prints a clear
 * skip message and exits 0. This phase is read-only: it never calls a write
 * tool. Token values are never printed; only tool names and outcomes are
 * logged.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OVERALL_DEADLINE_MS = 120_000;
const MESSAGE_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 5_000;
const STDERR_TAIL_LIMIT = 4_000;
const TEMP_DIR_PREFIX = "zendesk-mcp-e2e-";

const SERVER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "index.js",
);

class ConfigurationError extends Error {}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    log(`fatal: ${describe(error)}`);
    process.exitCode = 1;
  });

async function main() {
  const sandbox = readSandboxConfig();
  if (sandbox.skip) {
    // Unconfigured connectivity is a clean skip, not a failure.
    console.log(
      "harness: SKIP end-to-end run — ZENDESK_OAUTH_ACCESS_TOKEN is unset, " +
        "or neither ZENDESK_SUBDOMAIN nor ZENDESK_BASE_URL is set. " +
        "Set them to a disposable sandbox to run against live connectivity.",
    );
    return 0;
  }

  if (!existsSync(SERVER_PATH)) {
    console.error(
      `harness: built server not found at ${SERVER_PATH}. ` +
        "Run `npm run build` from plugins/zendesk-connector first.",
    );
    return 1;
  }

  const ticketId = resolveTicketId(process.env.ZENDESK_E2E_TICKET_ID);
  const steps = buildSteps(ticketId);

  // The OAuth client and token files are relocated into a private temp
  // directory so this run never reads the invoking host's real
  // ~/.config/codex-zendesk files, whatever is exported on the host.
  const tempDir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
  log(`temporary OAuth files in ${tempDir}`);

  let child;
  let watch;
  let session;
  let deadlineTimer;
  const results = [];
  const stderrTail = { text: "" };

  try {
    const clientFile = join(tempDir, "client.json");
    const tokenFile = join(tempDir, "oauth.json");
    // Empty placeholders: access-token mode never reads the token file, and
    // the client file must exist and be owner-only because the path is
    // explicitly set. Neither file contains any configured value.
    await writePlaceholder(clientFile);
    await writePlaceholder(tokenFile);

    const env = { ...process.env };
    // Always overwrite both paths, regardless of any ambient value, so a
    // host export can never point this run at the real owner-only files.
    env.ZENDESK_OAUTH_CLIENT_FILE = clientFile;
    env.ZENDESK_OAUTH_TOKEN_FILE = tokenFile;
    // The harness always runs in access-token mode; force it so an ambient
    // ZENDESK_OAUTH_MODE cannot divert the child into a refresh flow.
    env.ZENDESK_OAUTH_MODE = "access_token";

    child = spawn(process.execPath, [SERVER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    watch = watchChild(child);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrTail.text = (stderrTail.text + chunk).slice(-STDERR_TAIL_LIMIT);
    });

    session = new McpStdioSession(child);
    // A server that dies mid-session must fail pending requests promptly
    // instead of waiting for the per-message timeout.
    watch.settlement.then(() =>
      session.close("the server process exited before the session finished"),
    );

    const run = runSession(session, steps, ticketId, results);
    deadlineTimer = setTimeout(() => {
      log(`FAIL overall deadline of ${OVERALL_DEADLINE_MS} ms exceeded`);
      session.close(`the overall deadline of ${OVERALL_DEADLINE_MS} ms exceeded`);
      child.kill("SIGKILL");
    }, OVERALL_DEADLINE_MS);

    try {
      await run;
      return results.every((entry) => entry.ok) ? 0 : 1;
    } catch (error) {
      log(`FAIL run aborted: ${describe(error)}`);
      if (stderrTail.text) {
        log(`server stderr tail: ${stderrTail.text.trim()}`);
      }
      return 1;
    } finally {
      const passed = results.filter((entry) => entry.ok).length;
      log(`${passed} passed, ${results.length - passed} failed`);
      session.close("the end-to-end run has finished");
    }
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (child && watch) await stopChild(child, watch);
    await rm(tempDir, { recursive: true, force: true });
  }
}

/** Runs the MCP session: initialize, tools/list, then the read-only steps. */
async function runSession(session, steps, ticketId, results) {
  await session.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "zendesk-mcp-e2e-harness", version: "0.0.0" },
  });
  await session.notify("notifications/initialized");

  const listed = await session.request("tools/list", {});
  const available = new Set(
    (listed.tools ?? []).map((tool) => tool?.name).filter(Boolean),
  );
  for (const step of steps) {
    if (!available.has(step.tool)) {
      throw new Error(`the server does not list the expected tool ${step.tool}`);
    }
  }

  for (const step of steps) {
    try {
      const result = await session.request("tools/call", {
        name: step.tool,
        arguments: step.args,
      });
      verifyToolResult(step, result, { allowEmptySearch: ticketId === undefined });
      results.push({ tool: step.tool, ok: true });
      log(`PASS ${step.tool}`);
    } catch (error) {
      results.push({ tool: step.tool, ok: false, reason: describe(error) });
      log(`FAIL ${step.tool}: ${describe(error)}`);
      throw error;
    }
  }
}

/**
 * A tools/call response is only a PASS when the payload itself checks out:
 * the expected records are present, non-empty where the account always has
 * them, and key fields match what the run asked for.
 */
function verifyToolResult(step, result, context) {
  if (result?.isError) {
    throw new Error(`tool returned an error: ${truncate(toolText(result))}`);
  }
  const text = toolText(result);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`tool returned non-JSON text: ${truncate(text)}`);
  }
  step.verify(data, context);
}

function buildSteps(ticketId) {
  const steps = [
    {
      tool: "zendesk_status",
      args: {},
      verify: (data) => {
        if (data?.configured !== true) {
          throw new Error("expected configured to be true");
        }
        const user = expectObject(data.user, "user");
        expectPresent(user.id, "user.id");
      },
    },
    listStep("zendesk_list_brands", "brands"),
    listStep("zendesk_list_groups", "groups"),
    listStep("zendesk_list_users", "users"),
    // A brand-new account may genuinely have no organizations, so an empty
    // list is allowed here; the array itself must still be present.
    listStep("zendesk_list_organizations", "organizations", { allowEmpty: true }),
    listStep("zendesk_list_ticket_fields", "ticket_fields"),
    listStep("zendesk_list_ticket_forms", "ticket_forms"),
    {
      tool: "zendesk_search_tickets",
      args: { query: "type:ticket" },
      verify: (data, context) => {
        const results = expectArray(data, "results");
        for (const [index, record] of results.entries()) {
          expectPresent(record?.id, `results[${index}].id`);
          // Every result says what kind of record it is, so a consumer can
          // tell a ticket from a user or an organization.
          expectPresent(record?.resultType, `results[${index}].resultType`);
        }
        // With a ticket id configured the sandbox holds at least that
        // ticket, so the search must find records; without one an empty
        // account may legitimately return none.
        if (!context.allowEmptySearch && results.length === 0) {
          throw new Error("expected at least one search result");
        }
      },
    },
  ];

  if (ticketId !== undefined) {
    steps.push({
      tool: "zendesk_get_ticket",
      args: { ticketId, includeComments: true },
      verify: (data) => {
        const ticket = expectObject(data.ticket, "ticket");
        if (Number(ticket.id) !== ticketId) {
          throw new Error(`expected ticket.id ${ticketId}, received ${String(ticket.id)}`);
        }
        expectArray(data, "comments");
      },
    });
  }

  return steps;
}

function listStep(tool, field, { allowEmpty = false } = {}) {
  return {
    tool,
    args: {},
    verify: (data) => {
      const records = expectArray(data, field);
      if (!allowEmpty && records.length === 0) {
        throw new Error(`expected at least one record in ${field}`);
      }
    },
  };
}

function expectArray(data, field) {
  const value = data?.[field];
  if (!Array.isArray(value)) {
    throw new Error(`expected a ${field} array in the tool result`);
  }
  return value;
}

function expectObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value;
}

function expectPresent(value, label) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`expected ${label} to be present`);
  }
}

function toolText(result) {
  const part = result?.content?.find((item) => item?.type === "text");
  return typeof part?.text === "string" ? part.text : "";
}

/** Reads the sandbox configuration; unconfigured connectivity means skip. */
function readSandboxConfig() {
  const accessToken = process.env.ZENDESK_OAUTH_ACCESS_TOKEN?.trim();
  const subdomain = process.env.ZENDESK_SUBDOMAIN?.trim();
  const baseUrl = process.env.ZENDESK_BASE_URL?.trim();
  if (!accessToken || (!subdomain && !baseUrl)) {
    return { skip: true };
  }
  return { skip: false, accessToken, subdomain, baseUrl };
}

/**
 * Parses ZENDESK_E2E_TICKET_ID. Only digit strings inside the safe-integer
 * range are accepted: larger values would round (or become Infinity) and be
 * serialized as a different number or null in the tool call.
 */
function resolveTicketId(raw) {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new ConfigurationError(
      "ZENDESK_E2E_TICKET_ID must be a positive integer of digits only.",
    );
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id)) {
    throw new ConfigurationError(
      `ZENDESK_E2E_TICKET_ID ${value} is outside the safe-integer range.`,
    );
  }
  if (id <= 0) {
    throw new ConfigurationError("ZENDESK_E2E_TICKET_ID must be positive.");
  }
  return id;
}

async function writePlaceholder(path) {
  await writeFile(path, "{}\n", { mode: 0o600 });
  // writeFile's mode is masked by the umask; enforce the owner-only
  // permission the server requires on explicitly named OAuth files.
  await chmod(path, 0o600);
}

/**
 * Observes the child's `error` and `exit` events from the moment it is
 * created, so a spawn failure (which emits `error` early and never emits
 * `exit`) is still recorded by the time shutdown runs.
 */
function watchChild(child) {
  let settled = false;
  let spawnFailed = false;
  const settlement = new Promise((resolve) => {
    child.once("error", () => {
      spawnFailed = true;
      settled = true;
      resolve(undefined);
    });
    child.once("exit", () => {
      settled = true;
      resolve(undefined);
    });
  });
  return {
    settlement,
    get settled() {
      return settled;
    },
    get spawnFailed() {
      return spawnFailed;
    },
  };
}

/**
 * Stops the child and always returns: every wait is bounded by the shutdown
 * grace, including after the final SIGKILL, so cleanup finishes even when
 * the spawn itself failed or the child never emits `exit`.
 */
async function stopChild(child, watch) {
  if (!watch.settled) {
    child.kill("SIGTERM");
    await raceWithGrace(watch.settlement, SHUTDOWN_GRACE_MS);
  }
  if (!watch.settled && child.pid !== undefined) {
    try {
      child.kill("SIGKILL");
    } catch {
      // A process that already died cannot be signalled again.
    }
    await raceWithGrace(watch.settlement, SHUTDOWN_GRACE_MS);
  }
  return watch.settled;
}

/** Resolves true when the promise settles first, false on timeout. The
 * timeout timer is cleared as soon as the race settles, in every branch. */
function raceWithGrace(promise, milliseconds) {
  return new Promise((resolve) => {
    let timer = setTimeout(() => {
      timer = undefined;
      resolve(false);
    }, milliseconds);
    const settle = (value) => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      resolve(value);
    };
    promise.then(
      () => settle(true),
      () => settle(true),
    );
  });
}

/** Rejects with an Error after `milliseconds`; the timer is always cleared. */
async function withTimeout(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${milliseconds} ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A newline-delimited JSON-RPC MCP session over the child's stdio. */
class McpStdioSession {
  #child;
  #buffer = "";
  #nextId = 0;
  #pending = new Map();
  #closeReason;

  constructor(child) {
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#onData(chunk));
    // A stdin that closes early is reported through the pending-request
    // path instead of throwing from the stream.
    child.stdin.on("error", (error) => {
      this.close(`the server's stdin failed: ${error.message}`);
    });
  }

  request(method, params = {}) {
    if (this.#closeReason) {
      return Promise.reject(new Error(this.#closeReason));
    }
    const id = ++this.#nextId;
    const response = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#write({ jsonrpc: "2.0", id, method, params });
    return withTimeout(response, MESSAGE_TIMEOUT_MS, method);
  }

  async notify(method, params = {}) {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  /** Fails every pending request; later requests reject immediately. */
  close(reason) {
    if (this.#closeReason) return;
    this.#closeReason = reason;
    for (const { reject } of this.#pending.values()) {
      reject(new Error(reason));
    }
    this.#pending.clear();
  }

  #write(message) {
    const stream = this.#child.stdin;
    if (this.#closeReason || !stream?.writable) {
      throw new Error(this.#closeReason ?? "the server's stdin is not writable");
    }
    stream.write(`${JSON.stringify(message)}\n`);
  }

  #onData(chunk) {
    this.#buffer += chunk;
    let newline;
    while ((newline = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // The MCP stdio transport is newline-delimited JSON; a malformed
        // line leaves the pending request to hit its per-message timeout.
        continue;
      }
      if (message?.id === undefined || !this.#pending.has(message.id)) {
        continue; // server notification or an unknown id
      }
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            `JSON-RPC error: ${message.error.message ?? JSON.stringify(message.error)}`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
    }
  }
}

function log(message) {
  console.log(`harness: ${message}`);
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text, limit = 300) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
