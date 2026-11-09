import { z } from "zod";
import type { JsonObject } from "./shared.js";
import { readAnnotations, type RegisterAllowedTool, type ToolContext } from "./register.js";

export function registerStatusTool(
  register: RegisterAllowedTool,
  ctx: ToolContext,
): void {
  const { client } = ctx;

  register(
    "zendesk_status",
    {
      title: "Check Zendesk connection",
      description: "Check OAuth configuration and return the authenticated user.",
      inputSchema: z.object({}),
      annotations: readAnnotations,
    },
    "read",
    async () => {
      const response = await client.request<{ user: JsonObject }>(
        "/users/me.json",
        { object: "user" },
      );
      const authenticatedId = response.user.id;
      ctx.setActorId(
        typeof authenticatedId === "number" || typeof authenticatedId === "string"
          ? authenticatedId
          : undefined,
      );
      return {
        configured: true,
        baseUrl: client.baseUrl,
        oauth: client.auth.toolStatus(),
        user: response.user,
      };
    },
  );
}
