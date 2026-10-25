/**
 * Service Operations console server.
 *
 * The console is a reference app for a single Zendesk account. It keeps no
 * account data in this repository: every identifier it needs is read from the
 * environment when a request arrives, so the server still starts (and reports
 * the missing names) when the console is not configured.
 *
 * Required environment variables:
 *   ZENDESK_CONSOLE_BRAND_ID              brand the console is scoped to
 *   ZENDESK_CONSOLE_REQUEST_TYPE_FIELD_ID ticket field that carries the request type
 *   ZENDESK_CONSOLE_SYSTEM_FIELD_ID       ticket field that carries the system
 *   ZENDESK_CONSOLE_VIEW_OPEN_ID          view id for the open queue
 *   ZENDESK_CONSOLE_VIEW_UNTRIAGED_ID     view id for the untriaged queue
 *   ZENDESK_CONSOLE_VIEW_AGING_ID         view id for the aging report
 *   ZENDESK_CONSOLE_VIEW_REQUEST_TYPE_ID  view id for the request-type report
 *
 * Optional environment variables:
 *   ZENDESK_CONSOLE_RATE_LIMIT          requests a client may make per window
 *   ZENDESK_CONSOLE_RATE_LIMIT_WINDOW_MS length of that window in milliseconds
 *
 * `.env.example` next to this file lists the required variables with
 * placeholder values. Export them in the shell, or run
 * `node --env-file=.env server.mjs` once you have created a local `.env` file.
 *
 * HTTP endpoints:
 *   GET /api/status   liveness and configuration status; never calls Zendesk
 *   GET /api/overview the dashboard payload; calls Zendesk
 *
 * This module exports the Express app and the helpers it is built from, so the
 * test suite in `test/` can drive them without starting a server. The HTTP
 * listener and the frontend are only mounted when this file is run directly.
 */
import express from "express";
import rateLimit from "express-rate-limit";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const app = express();
const port = Number(process.env.PORT || 4177);
const root = dirname(fileURLToPath(import.meta.url));

const UNCLASSIFIED = "Unclassified";

const REQUIRED_CONFIG = {
  brandId: "ZENDESK_CONSOLE_BRAND_ID",
  requestTypeFieldId: "ZENDESK_CONSOLE_REQUEST_TYPE_FIELD_ID",
  systemFieldId: "ZENDESK_CONSOLE_SYSTEM_FIELD_ID",
  openViewId: "ZENDESK_CONSOLE_VIEW_OPEN_ID",
  untriagedViewId: "ZENDESK_CONSOLE_VIEW_UNTRIAGED_ID",
  agingViewId: "ZENDESK_CONSOLE_VIEW_AGING_ID",
  requestTypeViewId: "ZENDESK_CONSOLE_VIEW_REQUEST_TYPE_ID",
};

let tokenCache = { value: "", expiresAt: 0, baseUrl: "" };
let tokenRequest = null;
let overviewCache = { value: null, expiresAt: 0 };

// Returns the trimmed value of a console setting, or undefined when the
// variable is absent, empty or only whitespace.
function configValue(name) {
  const raw = process.env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

// Names the console settings that are missing, in the order they are declared.
export function missingConfigNames() {
  return Object.values(REQUIRED_CONFIG).filter((name) => configValue(name) === undefined);
}

// Reads the console configuration from the environment. Throws an error that
// names the missing variables; the caller turns it into a 503 response.
export function readConfig() {
  const values = {};
  const missing = [];
  for (const [key, name] of Object.entries(REQUIRED_CONFIG)) {
    const value = configValue(name);
    if (value === undefined) {
      missing.push(name);
      continue;
    }
    values[key] = value;
  }
  if (missing.length > 0) {
    throw new Error(`Missing console configuration: ${missing.join(", ")}`);
  }
  return {
    brandId: values.brandId,
    requestTypeFieldId: values.requestTypeFieldId,
    systemFieldId: values.systemFieldId,
    views: {
      open: values.openViewId,
      untriaged: values.untriagedViewId,
      aging: values.agingViewId,
      requestType: values.requestTypeViewId,
    },
  };
}

// The console is a local reference app, so the rate limit is generous: a few
// hundred requests a minute per client address.
const RATE_LIMIT_MAX = 300;
const RATE_LIMIT_WINDOW_MS = 60_000;

// Reads a positive whole number from the environment. An unset, malformed or
// non-positive value falls back to the given default.
function positiveIntFromEnv(name, fallback) {
  const raw = process.env[name];
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return value;
}

/**
 * The rate limit the file serving routes run under.
 *
 * The limit and the window come from the environment, so an operator can
 * tighten or loosen them without a code change. An unset, malformed or
 * non-positive value falls back to the default.
 */
export function rateLimitSettings(options = {}) {
  return {
    limit: options.limit ?? positiveIntFromEnv("ZENDESK_CONSOLE_RATE_LIMIT", RATE_LIMIT_MAX),
    windowMs: options.windowMs ?? positiveIntFromEnv("ZENDESK_CONSOLE_RATE_LIMIT_WINDOW_MS", RATE_LIMIT_WINDOW_MS),
  };
}

// Drops the cached token and dashboard payload. The caches live for the
// lifetime of the process; the test suite clears them between cases.
export function resetCaches() {
  tokenCache = { value: "", expiresAt: 0, baseUrl: "" };
  tokenRequest = null;
  overviewCache = { value: null, expiresAt: 0 };
}

export async function getOAuthToken() {
  if (tokenCache.value && tokenCache.expiresAt > Date.now() + 30_000) {
    return tokenCache;
  }
  // The dashboard reads two views at the same time, so the token request is
  // shared while it runs instead of asking the account for a token twice.
  if (!tokenRequest) {
    tokenRequest = requestToken().finally(() => {
      tokenRequest = null;
    });
  }
  return tokenRequest;
}

async function requestToken() {
  const path = process.env.ZENDESK_OAUTH_CLIENT_FILE ||
    join(homedir(), ".config", "codex-zendesk", "client.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  const baseUrl = config.baseUrl || `https://${config.subdomain}.zendesk.com`;
  const response = await fetch(`${baseUrl}/oauth/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: "read write",
    }),
  });
  if (!response.ok) throw new Error(`Zendesk OAuth failed (${response.status})`);
  const payload = await response.json();
  tokenCache = {
    value: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in || 3600) * 1000,
    baseUrl,
  };
  return tokenCache;
}

export async function zendesk(path) {
  const token = await getOAuthToken();
  const response = await fetch(`${token.baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token.value}`, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Zendesk request failed (${response.status})`);
  return response.json();
}

function bucketAge(days) {
  if (days <= 2) return "0-2 days";
  if (days <= 5) return "3-5 days";
  if (days <= 10) return "6-10 days";
  if (days <= 20) return "11-20 days";
  return "21+ days";
}

// Counts the request types the tickets actually carry. The console keeps no
// fixed taxonomy: names come from the data, the busiest value comes first,
// and the unclassified bucket always sorts last.
function countRequestTypes(tickets) {
  const counts = new Map();
  for (const ticket of tickets) {
    counts.set(ticket.requestType, (counts.get(ticket.requestType) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => {
      if (a.name === b.name) return 0;
      if (a.name === UNCLASSIFIED) return 1;
      if (b.name === UNCLASSIFIED) return -1;
      if (a.count !== b.count) return b.count - a.count;
      if (a.name < b.name) return -1;
      if (a.name > b.name) return 1;
      return 0;
    });
}

function summarize(rows, baseUrl, config) {
  const now = Date.now();
  const tickets = rows.map((row) => {
    const createdAt = row.created;
    const ageDays = Math.max(0, Math.floor((now - new Date(createdAt).getTime()) / 86_400_000));
    return {
      id: row.ticket.id,
      subject: row.subject,
      status: String(row.status || row.ticket.status),
      createdAt,
      ageDays,
      ageBucket: bucketAge(ageDays),
      requestType: row[config.requestTypeFieldId] || UNCLASSIFIED,
      system: row[config.systemFieldId] || "Not specified",
      assigneeId: row.assignee_id,
      url: `${baseUrl}/agent/tickets/${row.ticket.id}`,
    };
  });

  const countBy = (key, order) => order.map((name) => ({
    name,
    count: tickets.filter((ticket) => ticket[key] === name).length,
  }));
  return {
    tickets,
    aging: countBy("ageBucket", ["0-2 days", "3-5 days", "6-10 days", "11-20 days", "21+ days"]),
    requestTypes: countRequestTypes(tickets),
  };
}

// Reports that the console itself is running and whether it is configured.
// It never calls Zendesk, so it stays answerable when the account is down.
app.get("/api/status", (_request, response) => {
  const missing = missingConfigNames();
  response.json({
    ok: true,
    configured: missing.length === 0,
    missing,
  });
});

app.get("/api/overview", async (_request, response) => {
  try {
    const config = readConfig();
    if (overviewCache.value && overviewCache.expiresAt > Date.now()) {
      return response.json(overviewCache.value);
    }
    const [agingView, untriagedView] = await Promise.all([
      zendesk(`/api/v2/views/${config.views.aging}/execute.json`),
      zendesk(`/api/v2/views/${config.views.untriaged}/execute.json`),
    ]);
    const auth = await getOAuthToken();
    const summary = summarize(agingView.rows || [], auth.baseUrl, config);
    const payload = {
      connected: true,
      lastSynced: new Date().toISOString(),
      accountUrl: auth.baseUrl,
      brandId: config.brandId,
      metrics: {
        active: summary.tickets.length,
        untriaged: untriagedView.count || 0,
        unassigned: summary.tickets.filter((ticket) => !ticket.assigneeId).length,
        oldestDays: Math.max(0, ...summary.tickets.map((ticket) => ticket.ageDays)),
      },
      aging: summary.aging,
      requestTypes: summary.requestTypes,
      tickets: summary.tickets.slice(0, 8),
      views: Object.fromEntries(Object.entries(config.views).map(([name, id]) => [
        name,
        `${auth.baseUrl}/agent/filters/${id}`,
      ])),
    };
    overviewCache = { value: payload, expiresAt: Date.now() + 30_000 };
    response.json(payload);
  } catch (error) {
    response.status(503).json({
      connected: false,
      error: error instanceof Error ? error.message : "Zendesk is unavailable",
    });
  }
});

// Serves the built frontend: the static assets and the single page fallback
// that answers every other route with index.html. The rate limiter runs before
// both, so a client cannot make the console read files without limit.
export function mountStaticFiles(target, options = {}) {
  const distDir = options.distDir ?? join(root, "dist");
  const { limit, windowMs } = rateLimitSettings(options);
  // The limiter comes from `express-rate-limit`, the package rate limiting is
  // recognised by. It counts the requests of every client address inside the
  // window and answers the request that passes the limit with 429.
  const limiter = rateLimit({
    limit,
    windowMs,
    message: (_request, response) => ({
      error: "Too many requests",
      retryAfterSeconds: Number(response.getHeader("Retry-After")) || Math.ceil(windowMs / 1000),
    }),
    // A caller may pass its own store, so a test can count the requests of a
    // client without waiting for the window to pass.
    store: options.store,
  });
  target.use(limiter);
  target.use(express.static(distDir));
  target.use((_request, response) => response.sendFile(join(distDir, "index.html")));
  return limiter;
}

// True when this file is the process entry point. The frontend and the HTTP
// listener are only mounted then, so the test suite can import the app.
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(entry).href === import.meta.url;
  }
}

if (isMainModule()) {
  if (process.env.NODE_ENV !== "production") {
    const { createServer } = await import("vite");
    const vite = await createServer({ root, server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    mountStaticFiles(app);
  }

  app.listen(port, "127.0.0.1", () => {
    console.log(`Service Operations running at http://127.0.0.1:${port}`);
  });
}
