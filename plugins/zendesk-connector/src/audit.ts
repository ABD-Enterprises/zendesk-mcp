import type { OAuthMode } from "./auth.js";
import { PACKAGE_VERSION } from "./version.js";

type AuditValue = string | number | boolean | null;

export interface AuditEvent {
  event: "zendesk_tool_call";
  tool: string;
  operation: "read" | "write";
  outcome: "success" | "error";
  timestamp: string;
  status?: number;
  actorId?: number | string;
}

/** Receives one already-serialized JSON log line. */
export type LogSink = (line: string) => void;

/** What started a shutdown of the MCP server. */
export type ShutdownTrigger =
  | "sigint"
  | "sigterm"
  | "second-signal"
  | "timeout";

/** The lifecycle fields reported when the server shuts down. */
export interface ShutdownLogEvent {
  trigger: ShutdownTrigger;
  exitCode: number;
  details?: Record<string, unknown>;
}

export interface ServerStartEvent {
  event: "server_start";
  name: string;
  version: string;
  timestamp: string;
}

export interface ServerShutdownEvent {
  event: "server_shutdown";
  trigger: ShutdownTrigger;
  exitCode: number;
  timestamp: string;
  details?: Record<string, unknown>;
}

/** What happened to the persisted OAuth token file during a logout. */
export type StoredCredentialsState = "removed" | "absent" | "kept";

/** The lifecycle fields reported when the connector logs out. */
export interface OAuthLogoutEvent {
  event: "zendesk_oauth_logout";
  mode?: OAuthMode;
  outcome: "success" | "error";
  timestamp: string;
  /** True when Zendesk confirmed that the token was revoked. */
  revoked: boolean;
  /** The HTTP status Zendesk returned, undefined when no answer arrived. */
  status?: number;
  /** Why the logout did not fully succeed. Never carries credential material. */
  error?: string;
  /** True when the in-memory token cache was cleared. */
  clearedCache: boolean;
  /** What happened to the persisted OAuth token file. */
  storedCredentials: StoredCredentialsState;
}

const SERVER_NAME = "zendesk-mcp";

const stderrSink: LogSink = (line) => {
  process.stderr.write(line);
};

export function audit(event: Omit<AuditEvent, "event" | "timestamp">): void {
  const payload: AuditEvent = {
    event: "zendesk_tool_call",
    timestamp: new Date().toISOString(),
    ...event,
  };
  writeEvent(payload, stderrSink);
}

/** Reports that the MCP server started, without any credential material. */
export function logServerStart(sink: LogSink = stderrSink): void {
  const payload: ServerStartEvent = {
    event: "server_start",
    name: SERVER_NAME,
    version: PACKAGE_VERSION,
    timestamp: new Date().toISOString(),
  };
  writeEvent(payload, sink);
}

/** Reports that the MCP server stopped and why. */
export function logServerShutdown(
  event: ShutdownLogEvent,
  sink: LogSink = stderrSink,
): void {
  const payload: ServerShutdownEvent = {
    event: "server_shutdown",
    trigger: event.trigger,
    exitCode: event.exitCode,
    timestamp: new Date().toISOString(),
    ...(event.details ? { details: event.details } : {}),
  };
  writeEvent(payload, sink);
}

/**
 * Reports that the connector logged out of the Zendesk OAuth session. The
 * event names the outcome of the remote revocation and of the local cleanup,
 * and never carries credential material.
 */
export function logOAuthLogout(
  event: Omit<OAuthLogoutEvent, "event" | "timestamp">,
  sink: LogSink = stderrSink,
): void {
  const payload: OAuthLogoutEvent = {
    event: "zendesk_oauth_logout",
    timestamp: new Date().toISOString(),
    ...event,
  };
  writeEvent(payload, sink);
}

/** The names whose field values are credentials. */
const SENSITIVE_KEY = /token|secret|password|authorization|cookie/i;

/**
 * The names that mark a credential wherever they appear.
 *
 * The value layer adds the spellings that carry a credential rather than a
 * field name — `credential`, `api_key` and `api-key` — to the names the key
 * filter knows.
 */
const SENSITIVE_NAME =
  /token|secret|password|authorization|cookie|credential|api[-_]?key/i;

/** A word that can be part of a name. */
const NAME_TOKEN = /[A-Za-z0-9_.-]+/g;

/**
 * True when a value has the shape of a credential: opaque characters, a
 * length a word rarely reaches, and the marks of a token.
 */
function looksLikeCredential(value: string): boolean {
  if (!/^[A-Za-z0-9._~+/=-]{12,}$/.test(value)) return false;
  return (
    /[0-9._~+/=-]/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value))
  );
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "string") return scrubText(value);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => {
      if (SENSITIVE_KEY.test(key)) {
        return [key, "[REDACTED]" satisfies AuditValue];
      }
      return [key, redact(child)];
    }),
  );
}

/**
 * Redacts a credential that is parked in the value of an innocuous name.
 *
 * The key filter above cannot see such a credential: it matches names, not
 * contents. A body that answers `{"error_description":"client_secret <value>
 * rejected"}` keeps the credential in a string, and a string reaches the tool
 * output unchanged — the key filter never sees it. This layer therefore looks
 * inside strings and masks the credential that follows a name marking one.
 *
 * A value that follows a name and a separator is masked whatever its length,
 * the way the key filter masks a field whatever its value: the name declares
 * the value to be a credential. A value that merely stands next to a name is
 * masked only when it has the shape of a credential, so prose around a name
 * ("the password was rejected") survives.
 *
 * The scan walks the names in the text instead of matching a name anywhere in
 * it. A pattern would backtrack quadratically over a long string that holds no
 * credential, and the strings that reach here can be a whole error body from a
 * remote server — which is exactly the input an attacker chooses.
 */
function scrubText(value: string): string {
  // The Authorization header's own spelling. The keyword declares the value to
  // be a credential, so it is masked whatever it looks like.
  const scrubbed = value.replace(
    /\b(Bearer|Basic)\s+([^\s"',;]{4,})/gi,
    "$1 [REDACTED]",
  );

  const separator = /["']?[ \t]*[:=][ \t]*/y;
  const quotedValue = /"[^"]*"|'[^']*'/y;
  const bareValue = /[^\s"',;&}\]]+/y;
  const space = /[ \t]+/y;

  const names = [...scrubbed.matchAll(NAME_TOKEN)];
  let result = "";
  let copied = 0;

  for (let index = 0; index < names.length; index += 1) {
    const match = names[index];
    const name = match[0];
    // "api key" is one name written with a space.
    const next = names[index + 1];
    const isApiKey =
      name.toLowerCase() === "api" &&
      next !== undefined &&
      next[0].toLowerCase() === "key";
    if (!SENSITIVE_NAME.test(name) && !isApiKey) continue;

    const nameEnd = match.index + name.length;
    const searchFrom = isApiKey ? next.index + next[0].length : nameEnd;

    // A name and a separator: the value that follows is a credential.
    separator.lastIndex = searchFrom;
    const afterSeparator = separator.exec(scrubbed);
    if (afterSeparator) {
      const valueStart = searchFrom + afterSeparator[0].length;
      quotedValue.lastIndex = valueStart;
      const quoted = quotedValue.exec(scrubbed);
      bareValue.lastIndex = valueStart;
      const bare = quoted ?? bareValue.exec(scrubbed);
      if (!bare) continue;
      // A quoted value keeps its quotes: only the credential inside is masked.
      const maskedStart = quoted ? valueStart + 1 : valueStart;
      const maskedEnd = quoted ? valueStart + bare[0].length - 1 : valueStart + bare[0].length;
      result += scrubbed.slice(copied, maskedStart) + "[REDACTED]";
      copied = maskedEnd;
      // The names inside the masked value are gone with it.
      while (index + 1 < names.length && names[index + 1].index < copied) {
        index += 1;
      }
      continue;
    }

    // A name and a neighbouring credential: "client_secret <credential>". The
    // credential can stand one word further off ("the api key is <value>"),
    // so two words are looked at.
    let position = searchFrom;
    for (let word = 0; word < 2; word += 1) {
      space.lastIndex = position;
      const afterSpace = space.exec(scrubbed);
      if (!afterSpace) break;
      const valueStart = position + afterSpace[0].length;
      bareValue.lastIndex = valueStart;
      const bare = bareValue.exec(scrubbed);
      if (!bare) break;
      if (looksLikeCredential(bare[0])) {
        result += scrubbed.slice(copied, valueStart) + "[REDACTED]";
        copied = valueStart + bare[0].length;
        break;
      }
      position = valueStart + bare[0].length;
    }
  }

  return result + scrubbed.slice(copied);
}

function writeEvent(payload: unknown, sink: LogSink): void {
  sink(`${JSON.stringify(redact(payload))}\n`);
}
