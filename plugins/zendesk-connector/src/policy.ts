import { ZendeskAuthError } from "./auth.js";

const ALL_TOOLS = [
  "zendesk_status",
  "zendesk_search_tickets",
  "zendesk_get_ticket",
  "zendesk_create_ticket",
  "zendesk_update_ticket",
  "zendesk_add_ticket_comment",
] as const;

export type ZendeskToolName = (typeof ALL_TOOLS)[number];

export function configuredTools(): ReadonlySet<string> {
  const configured = process.env.ZENDESK_ALLOWED_TOOLS?.trim();
  if (!configured) return new Set(ALL_TOOLS);
  const requested = configured.split(",").map((tool) => tool.trim()).filter(Boolean);
  if (requested.length === 0) {
    throw new ZendeskAuthError("ZENDESK_ALLOWED_TOOLS must name at least one tool.");
  }
  if (new Set(requested).size !== requested.length) {
    throw new ZendeskAuthError("ZENDESK_ALLOWED_TOOLS must not contain duplicate tools.");
  }
  const unknown = requested.filter((tool) => !ALL_TOOLS.includes(tool as ZendeskToolName));
  if (unknown.length > 0) {
    throw new ZendeskAuthError(
      `ZENDESK_ALLOWED_TOOLS contains unsupported tools: ${unknown.join(", ")}.`,
    );
  }
  return new Set(requested);
}

export function toolNames(): readonly ZendeskToolName[] {
  return ALL_TOOLS;
}

export function assertToolAllowed(
  tools: ReadonlySet<string>,
  tool: ZendeskToolName,
): void {
  if (!tools.has(tool)) {
    throw new ZendeskAuthError(`Tool ${tool} is disabled by deployment policy.`);
  }
}

export function toolIsAllowed(tools: ReadonlySet<string>, tool: string): boolean {
  return tools.has(tool);
}
