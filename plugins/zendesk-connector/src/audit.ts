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

export function audit(event: Omit<AuditEvent, "event" | "timestamp">): void {
  const payload: AuditEvent = {
    event: "zendesk_tool_call",
    timestamp: new Date().toISOString(),
    ...event,
  };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
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
