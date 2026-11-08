import { env, ZendeskAuthError } from "./auth.js";

/**
 * Every tool the connector compiles, in the order the server registers them.
 *
 * This list is the single source of truth for the tool surface. The generated
 * documentation (the tool tables in the repository README, the tool
 * contracts reference and the plugin README) and the read-only allowlist in
 * `.env.example` are derived from it by `scripts/generate-tool-tables.mjs`,
 * so a tool added, renamed or removed here is picked up by the generated
 * sections or fails the drift check.
 */
export const ALL_TOOLS = [
  "zendesk_status",
  "zendesk_search_tickets",
  "zendesk_get_ticket",
  "zendesk_create_ticket",
  "zendesk_update_ticket",
  "zendesk_add_ticket_comment",
  "zendesk_list_brands",
  "zendesk_get_brand",
  "zendesk_list_groups",
  "zendesk_get_group",
  "zendesk_list_users",
  "zendesk_get_user",
  "zendesk_list_organizations",
  "zendesk_get_organization",
  "zendesk_list_ticket_fields",
  "zendesk_get_ticket_field",
  "zendesk_list_ticket_forms",
  "zendesk_get_ticket_form",
  "zendesk_list_views",
  "zendesk_list_view_tickets",
  "zendesk_get_view",
] as const;

export type ZendeskToolName = (typeof ALL_TOOLS)[number];

/**
 * The tools that change state in Zendesk. Every other tool only reads, so
 * read-only mode serves exactly the tools this list leaves out.
 */
export const WRITE_TOOLS = [
  "zendesk_create_ticket",
  "zendesk_update_ticket",
  "zendesk_add_ticket_comment",
] as const;

export type ZendeskWriteToolName = (typeof WRITE_TOOLS)[number];

const WRITE_TOOL_SET: ReadonlySet<string> = new Set(WRITE_TOOLS);

/** True when `ZENDESK_READ_ONLY` is set to an enabled value; rejects others. */
function readOnlyEnabled(): boolean {
  const raw = env("ZENDESK_READ_ONLY")?.toLowerCase();
  if (raw === undefined) return false;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new ZendeskAuthError("ZENDESK_READ_ONLY must be 1, true, 0, or false.");
}

export function configuredTools(): ReadonlySet<string> {
  const readOnly = readOnlyEnabled();
  const configured = env("ZENDESK_ALLOWED_TOOLS");
  if (!configured) {
    if (!readOnly) return new Set(ALL_TOOLS);
    const readTools = ALL_TOOLS.filter((tool) => !WRITE_TOOL_SET.has(tool));
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
    const writes = requested.filter((tool) => WRITE_TOOL_SET.has(tool));
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

/**
 * The tools that only read, in the order `ALL_TOOLS` lists them. Read-only
 * mode serves exactly these.
 */
export function readToolNames(): readonly ZendeskToolName[] {
  return ALL_TOOLS.filter((tool) => !WRITE_TOOL_SET.has(tool));
}

/** The tools that write, in the order `ALL_TOOLS` lists them. */
export function writeToolNames(): readonly ZendeskToolName[] {
  return ALL_TOOLS.filter((tool) => WRITE_TOOL_SET.has(tool));
}

/** Whether a tool reads or writes. */
export function toolAccess(tool: ZendeskToolName): "read" | "write" {
  return WRITE_TOOL_SET.has(tool) ? "write" : "read";
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
