#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logServerShutdown, logServerStart } from "./audit.js";
import { isDoctorRequested, isToolsRequested, runDoctor } from "./doctor.js";
import {
  isHealthCheckFlag,
  isHealthCheckRequested,
  runHealthCheck,
} from "./health.js";
import { isLogoutRequested, runLogout } from "./logout.js";
import { createZendeskServer } from "./server.js";
import { installShutdownHandlers } from "./shutdown.js";

const argv = process.argv.slice(2);
const wantsTools = isToolsRequested(argv);
// The inventory is part of the doctor: asking for it means running the
// preflight, not starting the server.
const wantsDoctor = isDoctorRequested(argv) || wantsTools;
const wantsLogout = isLogoutRequested(argv);

// An explicit command-line flag wins over the environment-variable shortcut:
// a host that exports ZENDESK_HEALTHCHECK=1 still gets the mode its command
// line asks for, instead of a healthcheck that would silently skip the
// doctor's or the logout's checks.
if (
  isHealthCheckFlag(argv) ||
  (!wantsDoctor && !wantsLogout && isHealthCheckRequested())
) {
  process.exitCode = runHealthCheck();
} else if (wantsDoctor) {
  process.exitCode = await runDoctor();
} else if (wantsLogout) {
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
