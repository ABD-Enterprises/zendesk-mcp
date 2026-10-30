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
 *   ZENDESK_CONSOLE_ALLOWED_HOSTS        Host headers a proxy in front of the
 *                                        console forwards, when it has one
 *   ZENDESK_CONSOLE_OAUTH_SCOPE          the scope the console's own token
 *                                        asks for
 *
 * `.env.example` next to this file lists the required variables with
 * placeholder values. Export them in the shell, or run
 * `node --env-file=.env server.mjs` once you have created a local `.env` file.
 *
 * HTTP endpoints:
 *   GET /api/status   liveness and configuration status; never calls Zendesk
 *   GET /api/overview the dashboard payload; calls Zendesk
 *
 * The server binds to the loopback interface and, by default, answers only a
 * request that carries a loopback Host header: a page on another origin can
 * reach a loopback server through DNS rebinding, and the Host header is what
 * tells the two apart. A console behind a reverse proxy names the proxy's
 * host in ZENDESK_CONSOLE_ALLOWED_HOSTS, and then answers that name too; the
 * proxy's own access control is what stands in front of it.
 *
 * This module exports the Express app and the helpers it is built from, so the
 * test suite in `test/` can drive them without starting a server. The HTTP
 * listener and the frontend are only mounted when this file is run directly.
 */
import express from "express";
import rateLimit from "express-rate-limit";
import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const app = express();
const port = Number(process.env.PORT || 4177);
const root = dirname(fileURLToPath(import.meta.url));

const UNCLASSIFIED = "Unclassified";

/**
 * An error whose message the console wrote itself.
 *
 * Only these messages reach the browser. An error the console did not write
 * — a malformed client file, say — can carry the file's own bytes in its
 * text, so it is logged for the operator and answered with a fixed message
 * instead.
 */
class ConsoleError extends Error {}

/**
 * The scope the console asks for when the operator names none.
 *
 * The console reads two ticket views and nothing else. Zendesk scopes a view
 * by its own scope — `ticket_views:read` is documented as "view ticket views
 * and the tickets they return" — and `tickets:read` covers the ticket fields
 * the dashboard reads off the rows a view returns. Those two are the whole of
 * what the console needs.
 */
const CONSOLE_DEFAULT_SCOPE = "ticket_views:read tickets:read";

// The scopes the console cannot work without. The broad `read` scope covers
// every GET endpoint, so it covers both of them.
//
// Zendesk documents `ticket_views:read` as "view ticket views and the tickets
// they return", which may already cover the fields the dashboard reads off
// the rows; `tickets:read` names ticket fields explicitly, and is the scope
// that certainly carries them. The console asks for both so that it does not
// depend on which of the two an account grants, and refuses a token that can
// read neither: a dashboard that quietly answered "Unclassified" for every
// ticket would be a dashboard that was wrong without saying so.
const CONSOLE_REQUIRED_SCOPES = ["ticket_views:read", "tickets:read"];

/**
 * The scope the console asks its own token for.
 *
 * The scope comes from the environment: `ZENDESK_CONSOLE_OAUTH_SCOPE` first,
 * then the `ZENDESK_OAUTH_SCOPE` the connector shares with it, then the
 * console's own default. The scope recorded in the client file is the
 * connector's scope — it names what the connector reads and it carries write
 * scopes — so the console does not take it.
 *
 * The write scopes are dropped, because the console writes nothing. An
 * operator who deliberately narrowed the account to read-only therefore does
 * not get a write-capable console token.
 *
 * What is left must still let the console read a view and the ticket fields
 * on it. The console never adds a scope of its own to make that true:
 * Zendesk caps what a client may request at the scopes allowed on the OAuth
 * client and answers a request outside that set with `400 invalid_scope`, so
 * adding `ticket_views:read` behind the operator's back would take the
 * console down for an operator whose client does not carry it. A scope that
 * cannot read a view is a configuration error, and the console names the
 * scopes it needs.
 */
export function resolveConsoleScope() {
  const configured =
    configValue("ZENDESK_CONSOLE_OAUTH_SCOPE") ?? configValue("ZENDESK_OAUTH_SCOPE");
  const scope = configured === undefined ? CONSOLE_DEFAULT_SCOPE : configured;
  // Only the read scopes survive. The broad `read` scope is a read scope
  // too: it covers every GET endpoint.
  const readOnly = scope
    .split(/\s+/)
    .filter((part) => part === "read" || part.endsWith(":read"));
  // The broad `read` scope covers both of the required scopes.
  const missing = CONSOLE_REQUIRED_SCOPES.filter(
    (required) => !readOnly.includes(required) && !readOnly.includes("read"),
  );
  if (readOnly.length === 0 || missing.length > 0) {
    throw new ConsoleError(
      `The console reads ticket views and the ticket fields on them, so its token needs ` +
        `the ${missing.join(" and ")} scope${missing.length > 1 ? "s" : ""}. ` +
        "Add " +
        (missing.length > 1 ? "them" : "it") +
        " to ZENDESK_CONSOLE_OAUTH_SCOPE (or to ZENDESK_OAUTH_SCOPE) and allow " +
        (missing.length > 1 ? "them" : "it") +
        " on the Zendesk OAuth client.",
    );
  }
  return readOnly.join(" ");
}

/**
 * The account URL the console posts the client secret to.
 *
 * The rule is the connector's own: the URL must be HTTPS, and plain HTTP is
 * allowed only for a local host. The two halves of the project have to agree
 * on the boundary, or the console would send the secret to whatever the
 * client file names.
 */
function validateBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConsoleError("The Zendesk account URL is not a valid URL.");
  }
  // `new URL` keeps the brackets of an IPv6 literal, so they come off before
  // the host is compared.
  const hostname = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  const isLocalhost =
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost)) {
    throw new ConsoleError(
      "The Zendesk account URL must use HTTPS (HTTP is allowed only for localhost).",
    );
  }
  return url.origin;
}

/**
 * The account URL, validated the way the connector validates it — but taken
 * from the client file alone.
 *
 * The client file names the account, so the console reads the one the
 * connector reads. The environment does not: an exported ZENDESK_BASE_URL or
 * ZENDESK_SUBDOMAIN names an account for the connector, and following it here
 * would send the client secret to that other account, which the console has
 * no reason to do.
 */
export function resolveConsoleBaseUrl(client) {
  // The account comes from the client file, not from the environment. An
  // exported ZENDESK_BASE_URL or ZENDESK_SUBDOMAIN names an account for the
  // connector; following it here would send the client secret to that other
  // account, which the console has no reason to do.
  const baseUrl = typeof client.baseUrl === "string" ? client.baseUrl.trim() : "";
  if (baseUrl) {
    return validateBaseUrl(baseUrl.replace(/\/+$/, ""));
  }

  const subdomain =
    typeof client.subdomain === "string" ? client.subdomain.trim() : "";
  if (!subdomain) {
    throw new ConsoleError(
      'The OAuth client file does not name an account. Add a "baseUrl" or a "subdomain" to it.',
    );
  }
  if (subdomain.startsWith("http://") || subdomain.startsWith("https://")) {
    return validateBaseUrl(subdomain.replace(/\/+$/, ""));
  }
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(subdomain)) {
    throw new ConsoleError(
      "The account subdomain in the OAuth client file is not a valid subdomain.",
    );
  }
  return `https://${subdomain}.zendesk.com`;
}

/**
 * True when a Host header names the loopback interface.
 *
 * The console serves live ticket data to a local browser, and a page on
 * another origin can reach it: DNS rebinding resolves an attacker's name to
 * 127.0.0.1, and the browser then treats the answer as same-origin to the
 * attacker's page. The Host header is what tells the two apart, so it is
 * checked before any route runs. Binding to the loopback address does not
 * defend against this: the request still comes from the victim's browser.
 */
export function isLoopbackHost(hostHeader) {
  if (typeof hostHeader !== "string" || hostHeader === "") return false;
  let host = hostHeader;
  let port = "";
  if (hostHeader.startsWith("[")) {
    // An IPv6 literal carries its own brackets.
    const end = hostHeader.indexOf("]");
    if (end === -1) return false;
    host = hostHeader.slice(1, end);
    const rest = hostHeader.slice(end + 1);
    if (rest !== "") {
      if (!rest.startsWith(":")) return false;
      port = rest.slice(1);
    }
  } else if (hostHeader.split(":").length > 2) {
    // A bare IPv6 literal, which a Host header carries without brackets only
    // by mistake but which names the loopback interface.
    host = hostHeader;
  } else {
    const colon = hostHeader.lastIndexOf(":");
    if (colon !== -1) {
      host = hostHeader.slice(0, colon);
      port = hostHeader.slice(colon + 1);
    }
  }
  // Anything but a port number after the name means the header names
  // something else: "127.0.0.1:4177.example.com" is not the console.
  if (port !== "" && !/^\d+$/.test(port)) return false;
  const name = host.toLowerCase();
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

/**
 * The Host header values the console answers to besides the loopback names.
 *
 * A reverse proxy in front of the console forwards the name the browser asked
 * for, not the loopback address, so a console behind a proxy needs the
 * proxy's name on this list. The list is empty unless the operator fills it
 * in: a console that answers to a name nobody told it about is a console
 * that answers to anything.
 *
 * Each entry is matched against the whole Host header, port included. That
 * is what keeps a rebound name out: a browser that reaches the console's own
 * port sends "name:port", which no entry matches, so the console stays
 * unreachable under a name it was given for a proxy in front of it.
 */
export function allowedHosts() {
  const raw = configValue("ZENDESK_CONSOLE_ALLOWED_HOSTS");
  if (raw === undefined) return [];
  return raw
    .split(/[,\s]+/)
    .filter((entry) => entry !== "")
    .map((entry) => entry.toLowerCase());
}

/**
 * True when a Host header names the console.
 *
 * The loopback names are always the console's own. Anything else has to be on
 * the operator's list, and then it has to match the header exactly.
 */
export function isAllowedHost(hostHeader, extraHosts = []) {
  if (isLoopbackHost(hostHeader)) return true;
  if (typeof hostHeader !== "string" || hostHeader === "") return false;
  // The list has to be a list. A string would turn the whole-header match
  // into a substring match, which is the opposite of what the check is for.
  if (!Array.isArray(extraHosts)) return false;
  return extraHosts.includes(hostHeader.trim().toLowerCase());
}

/**
 * The middleware that refuses a request that was not addressed to the console.
 *
 * It is exported so the test suite can mount it ahead of the file routes and
 * prove that a request for the frontend is refused the same way a request for
 * an API route is.
 */
export function hostCheck(request, response, next) {
  if (isAllowedHost(request.headers.host, allowedHosts())) {
    next();
    return;
  }
  response.status(403).json({ error: "Forbidden" });
}

// Refuses a request that was not addressed to the console itself. It runs
// before every route, the API ones included.
app.use(hostCheck);

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
  if (trimmed === "") return undefined;
  // A literal placeholder is not a value: the connector reads it the same way,
  // so a manifest that leaves "${ZENDESK_...}" in place is unset here too.
  if (/^\$\{[^}]*\}$/.test(trimmed)) return undefined;
  return trimmed;
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
    throw new ConsoleError(`Missing console configuration: ${missing.join(", ")}`);
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
  let client;
  try {
    // The file holds the client secret, and the console posts that secret to
    // the account the file names, so the file has to be one only its owner
    // can write — the rule the connector already applies to it.
    const stats = await stat(path);
    if (!stats.isFile()) {
      throw new ConsoleError(
        "The Zendesk OAuth client file is not a regular file.",
      );
    }
    // Node reports synthetic permission bits on Windows (group and other
    // always look set), so the check is skipped there instead of failing
    // every run.
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
      throw new ConsoleError(
        "The Zendesk OAuth client file must be readable only by its owner (chmod 600).",
      );
    }
    client = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof ConsoleError) throw error;
    // A parse error can carry a fragment of the file in its text on some
    // Node versions — the client id or the secret — so the reason is logged
    // and not shown.
    console.error(`[operations-console] the client file ${path} could not be read:`, error);
    throw new ConsoleError("The Zendesk OAuth client file could not be read.");
  }
  const baseUrl = resolveConsoleBaseUrl(client);
  // The scope the console asks for. It is worked out once, so the advice the
  // console gives when the account refuses names the scopes it asked for.
  const scope = resolveConsoleScope();
  const response = await fetch(`${baseUrl}/oauth/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // A redirect is not followed. The account URL was validated before the
    // request, and a redirect would carry the client secret — and the scopes
    // it was granted — to a host the console never looked at.
    redirect: "manual",
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: client.clientId,
      client_secret: client.clientSecret,
      scope,
    }),
  });
  if (response.status >= 300 && response.status < 400) {
    throw new ConsoleError(
      "The account URL redirected the token request. The console does not follow a redirect, because one would carry the client secret to an account it never validated.",
    );
  }
  if (!response.ok) {
    // The body names why the token was refused — "invalid_scope" for a client
    // that was not granted the scopes the console asks for — and that is the
    // difference between a fixable setup and a wrong password.
    const code = await oauthErrorCode(response);
    throw new ConsoleError(
      `Zendesk OAuth failed (${response.status}${code ? ` ${code}` : ""})` +
        (code === "invalid_scope"
          ? `. The console's token needs the ${scope.split(" ").join(" and ")} scope${scope.split(" ").length > 1 ? "s" : ""}: allow ${scope.split(" ").length > 1 ? "them" : "it"} on the Zendesk OAuth client.`
          : ""),
    );
  }
  const payload = await response.json();
  tokenCache = {
    value: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in || 3600) * 1000,
    baseUrl,
  };
  return tokenCache;
}

// The OAuth error codes the console names.
//
// The body of a refused token request is written by the account, so only the
// codes in this fixed vocabulary reach the browser. Anything else could be a
// value the console did not write, and the promise the console makes is that
// only its own messages are shown.
const OAUTH_ERROR_CODES = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "access_denied",
]);

// The error code of a refused token request, when the body names one.
async function oauthErrorCode(response) {
  try {
    const body = await response.json();
    const code = body && typeof body.error === "string" ? body.error : "";
    return OAUTH_ERROR_CODES.has(code) ? code : "";
  } catch {
    return "";
  }
}

export async function zendesk(path) {
  const token = await getOAuthToken();
  const response = await fetch(`${token.baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token.value}`, Accept: "application/json" },
    // A redirect is not followed here either: it would carry the access
    // token to a host the console never validated.
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    throw new ConsoleError(
      "The account URL redirected the request. The console does not follow a redirect, because one would carry the access token to an account it never validated.",
    );
  }
  if (!response.ok) throw new ConsoleError(`Zendesk request failed (${response.status})`);
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
    // The reason is logged for the operator; only a message the console wrote
    // itself reaches the browser.
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[operations-console] the dashboard could not be read: ${detail}`);
    response.status(503).json({
      connected: false,
      error: error instanceof ConsoleError ? detail : "Zendesk is unavailable",
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
