#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logServerShutdown, logServerStart } from "./audit.js";
import { isHealthCheckRequested, runHealthCheck } from "./health.js";
import { isLogoutRequested, runLogout } from "./logout.js";
import { createZendeskServer } from "./server.js";
import { installShutdownHandlers } from "./shutdown.js";

if (isHealthCheckRequested()) {
  process.exitCode = runHealthCheck();
} else if (isLogoutRequested()) {
  process.exitCode = await runLogout();
} else {
  const server = createZendeskServer();

  installShutdownHandlers({
    close: () => server.close(),
    log: (event) => logServerShutdown(event),
    exit: (code) => {
      process.exitCode = code;
      // Flush pending stderr writes before leaving the process.
      process.stderr.write("", () => {
        process.exit(code);
      });
    },
  });

  logServerStart();
  await server.connect(new StdioServerTransport());
}
