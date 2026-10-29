import { ZendeskAuthError } from "./auth.js";

const ALL_TOOLS = [
  "zendesk_status",
  "zendesk_search_tickets",
  "zendesk_get_ticket",
  "zendesk_create_ticket",
  "zendesk_update_ticket",
  "zendesk_add_ticket_comment",
  "zendesk_list_brands",
  "zendesk_list_groups",
  "zendesk_list_users",
  "zendesk_list_organizations",
  "zendesk_list_ticket_fields",
  "zendesk_list_ticket_forms",
] as const;

export type ZendeskToolName = (typeof ALL_TOOLS)[number];

const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "zendesk_create_ticket",
  "zendesk_update_ticket",
  "zendesk_add_ticket_comment",
]);

/** True when `ZENDESK_READ_ONLY` is set to an enabled value; rejects others. */
function readOnlyEnabled(): boolean {
  const raw = process.env.ZENDESK_READ_ONLY?.trim().toLowerCase();
  if (raw === undefined || raw === "") return false;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new ZendeskAuthError("ZENDESK_READ_ONLY must be 1, true, 0, or false.");
}

export function configuredTools(): ReadonlySet<string> {
  const readOnly = readOnlyEnabled();
  const configured = process.env.ZENDESK_ALLOWED_TOOLS?.trim();
  if (!configured) {
    if (!readOnly) return new Set(ALL_TOOLS);
    const readTools = ALL_TOOLS.filter((tool) => !WRITE_TOOLS.has(tool));
    return new Set(readTools);
  }
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
  if (readOnly) {
    const writes = requested.filter((tool) => WRITE_TOOLS.has(tool));
    if (writes.length > 0) {
      throw new ZendeskAuthError(
        `ZENDESK_READ_ONLY conflicts with write tools in ZENDESK_ALLOWED_TOOLS: ${writes.join(", ")}.`,
      );
    }
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
