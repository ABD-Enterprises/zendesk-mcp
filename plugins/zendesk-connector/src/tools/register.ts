import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ZendeskAuthError } from "../auth.js";
import { audit, redact } from "../audit.js";
import { ZendeskError, type ZendeskClient } from "../client.js";
import { assertToolAllowed, type ZendeskToolName } from "../policy.js";

/**
 * The state every tool registration operates on: the HTTP client, the
 * deployment allowlist and the id of the authenticated user, which
 * `zendesk_status` learns and every later audit record names.
 */
export interface ToolContext {
  readonly client: ZendeskClient;
  readonly allowedTools: ReadonlySet<string>;
  getActorId(): number | string | undefined;
  setActorId(id: number | string | undefined): void;
}

export const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * The annotations of a write tool.
 *
 * `destructive` says whether the tool may overwrite something that already
 * exists. It is not a read-only flag: a tool that only adds records is
 * additive, while one that replaces a ticket's fields or sends a public reply
 * destroys something — and a host that trusts the hint would otherwise skip
 * the confirmation prompt for exactly those two.
 */
export function writeAnnotations(options: {
  idempotent: boolean;
  destructive: boolean;
}) {
  return {
    readOnlyHint: false,
    destructiveHint: options.destructive,
    idempotentHint: options.idempotent,
    openWorldHint: true,
  } as const;
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(error: unknown) {
  const payload =
    error instanceof ZendeskError || error instanceof ZendeskAuthError
      ? { error: error.message, status: error.status, details: error.details }
      : { error: error instanceof Error ? error.message : String(error) };
  const safePayload = redact(payload);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(safePayload, null, 2) }],
  };
}

async function runTool(
  tool: ZendeskToolName,
  operation: "read" | "write",
  actorId: number | string | undefined,
  action: () => Promise<unknown>,
) {
  try {
    const value = await action();
    audit({ tool, operation, outcome: "success", actorId });
    return toolResult(value);
  } catch (error) {
    audit({
      tool,
      operation,
      outcome: "error",
      actorId,
      status: error instanceof ZendeskError || error instanceof ZendeskAuthError ? error.status : undefined,
    });
    return errorResult(error);
  }
}

/**
 * Registers one tool with the shared wrapper every registration uses:
 * the deployment allowlist decides whether the tool exists at all, the
 * policy guard re-checks inside the call, and the whole handler runs
 * through the audit/`runTool` envelope.
 */
export type RegisterAllowedTool = <S extends z.ZodRawShape>(
  name: ZendeskToolName,
  config: {
    title: string;
    description: string;
    inputSchema: z.ZodObject<S>;
    annotations: ToolAnnotations;
  },
  operation: "read" | "write",
  handler: (args: z.output<z.ZodObject<S>>) => Promise<unknown>,
) => void;

export function createRegistrar(
  server: McpServer,
  ctx: ToolContext,
): RegisterAllowedTool {
  return function register<S extends z.ZodRawShape>(
    name: ZendeskToolName,
    config: {
      title: string;
      description: string;
      inputSchema: z.ZodObject<S>;
      annotations: ToolAnnotations;
    },
    operation: "read" | "write",
    handler: (args: z.output<z.ZodObject<S>>) => Promise<unknown>,
  ): void {
    if (!ctx.allowedTools.has(name)) return;
    server.registerTool<AnySchema, z.ZodObject<S>>(name, config, async (args) =>
      runTool(name, operation, ctx.getActorId(), async () => {
        assertToolAllowed(ctx.allowedTools, name);
        return handler(args);
      }),
    );
  };
}
