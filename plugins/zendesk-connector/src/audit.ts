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
  process.stderr.write(`${JSON.stringify(payload)}\n`);
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

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => {
      if (/token|secret|password|authorization|cookie/i.test(key)) {
        return [key, "[REDACTED]" satisfies AuditValue];
      }
      return [key, redact(child)];
    }),
  );
}

function writeEvent(payload: unknown, sink: LogSink): void {
  sink(`${JSON.stringify(redact(payload))}\n`);
}
