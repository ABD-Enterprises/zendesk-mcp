import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import {
  CALLBACK_PORT_ERROR,
  getConfig,
  isValidCallbackPort,
  resolveCallbackPort,
  type ZendeskConfig,
} from "./auth.js";
import { assertUsableConfig } from "./health.js";
import { configuredTools } from "./policy.js";

/** The configuration fields the doctor inspects beyond startup validation. */
type DoctorConfig = Pick<ZendeskConfig, "baseUrl" | "mode" | "tokenFile">;

/** What the loopback port probe found when it tried to bind. */
export type PortProbeResult =
  /** The port binds right now. */
  | "free"
  /** Another process already holds the port. */
  | "in-use"
  /** The port cannot be bound at all (for example a privileged port). */
  | "unavailable";

export interface DoctorOptions {
  /** Loads the OAuth configuration. Defaults to `getConfig`. */
  loadConfig?: () => DoctorConfig;
  /**
   * Reports whether the loopback callback port can be bound, and why not.
   * Defaults to a real bind.
   */
  probePort?: (port: number) => Promise<PortProbeResult>;
  /** Writes the all-clear line to stdout. */
  writeOut?: (line: string) => void;
  /** Writes one line per failing check to stderr. */
  writeError?: (line: string) => void;
}

interface TokenFileState {
  /**
   * True when the stored token cannot be used and the remedy is to run
   * `npm run oauth:setup` again — the one problem whose fix needs the
   * callback port, so the port check runs for these states too. A missing
   * file or parent directory is ENOENT, so it stays true: setup creates the
   * parent when it stores the token. Other file-state problems (a directory
   * where the file belongs, loose permissions) set it to false: re-running
   * setup does not obviously fix them.
   */
  setupNeeded: boolean;
  /** Why the token file is not usable as stored, undefined when it is fine. */
  problem?: string;
}

/** Reports whether the process was asked to run the doctor preflight. */
export function isDoctorRequested(
  argv: string[] = process.argv.slice(2),
): boolean {
  return argv.includes("--doctor");
}

/**
 * Runs every doctor check without contacting Zendesk and returns one
 * actionable message per failing check, in check order.
 *
 * Checks, in order: the OAuth configuration (the same validation startup
 * performs, including the client file's permission requirement), the tool
 * policy, the setup callback port, and the authorization-code token file. The
 * port and token-file checks run only in `authorization_code` mode, and the
 * port is checked only when re-running `npm run oauth:setup` is the token's
 * remedy — the file is missing, unparseable, or lacks a token field (a path
 * or permission problem skips it), and setup needs the port. A failing
 * configuration skips the two dependent checks, so a single run never repeats
 * the same problem.
 */
export async function checkDoctor(
  options: DoctorOptions = {},
): Promise<string[]> {
  const problems: string[] = [];
  let config: DoctorConfig | undefined;
  try {
    const loaded = (options.loadConfig ?? getConfig)();
    assertUsableConfig(loaded);
    config = loaded;
  } catch (error) {
    problems.push(errorMessage(error));
  }

  try {
    configuredTools();
  } catch (error) {
    problems.push(errorMessage(error));
  }

  if (config?.mode === "authorization_code") {
    const token = inspectTokenFile(config.tokenFile);
    if (token.setupNeeded) {
      const portProblem = await checkCallbackPort(options.probePort);
      if (portProblem) problems.push(portProblem);
    }
    if (token.problem) problems.push(token.problem);
  }

  return problems;
}

/**
 * Runs the doctor preflight: one line per failing check on stderr and exit 1,
 * or a single all-clear line on stdout and exit 0. The configuration messages
 * and the token file's missing/unparseable/incomplete messages reuse the exact
 * error strings startup produces; the port and the token file-state messages
 * are the doctor's own. None of them carry credential material.
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<number> {
  const writeOut =
    options.writeOut ??
    ((line: string) => {
      process.stdout.write(line);
    });
  const writeError =
    options.writeError ??
    ((line: string) => {
      process.stderr.write(line);
    });

  const problems = await checkDoctor(options);
  if (problems.length === 0) {
    writeOut("Zendesk connector doctor: all checks passed.\n");
    return 0;
  }
  for (const problem of problems) writeError(`${problem}\n`);
  return 1;
}

/**
 * Inspects the stored authorization-code token file: its file state first
 * (present, a regular file, owner-only permissions), then its contents
 * (parseable JSON with an `access_token` and a `refresh_token`).
 *
 * The missing-file, unparseable, and incomplete-token messages reuse the
 * exact strings startup produces, so the troubleshooting table covers the
 * doctor's output too. The file-state messages (unreadable path, not a
 * regular file, permissions) are the doctor's own: startup reads the token
 * file without inspecting it, and the permission check is additionally
 * skipped on Windows, where Node reports synthetic permission bits.
 */
function inspectTokenFile(tokenFile: string): TokenFileState {
  const unreadable: TokenFileState = {
    setupNeeded: true,
    problem: `Unable to read OAuth token file ${tokenFile}. Run npm run oauth:setup from the plugin directory.`,
  };

  let mode: number;
  let isFile: boolean;
  try {
    const stats = statSync(tokenFile);
    mode = stats.mode;
    isFile = stats.isFile();
  } catch (error) {
    // ENOENT means setup has not stored a token yet, so its message points
    // at oauth:setup and the port that a re-run needs is probed. Any other
    // stat failure (a directory in the path, a path this user cannot read)
    // is a file-state problem that re-running setup may not fix, so it gets
    // its own message and no port probe.
    const missing =
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT";
    return missing
      ? unreadable
      : {
          setupNeeded: false,
          problem: `Unable to read OAuth token file ${tokenFile}. Check that the path exists and this user can access it.`,
        };
  }

  if (!isFile) {
    return {
      setupNeeded: false,
      problem: `OAuth token file ${tokenFile} is not a regular file.`,
    };
  }
  // Node reports synthetic permission bits on Windows (group and other always
  // look set), so the check is skipped there instead of failing every run.
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    return {
      setupNeeded: false,
      problem: `OAuth token file ${tokenFile} must be readable only by its owner (chmod 600).`,
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(tokenFile, "utf8"));
  } catch {
    return unreadable;
  }
  const token = (payload ?? {}) as {
    access_token?: unknown;
    refresh_token?: unknown;
  };
  // A stored token must be a non-empty string: a boolean or number would
  // pass a truthiness check here and then be sent as an unusable credential,
  // so the doctor reports it as the missing token it effectively is.
  const usable = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0;
  if (!usable(token.access_token)) {
    return {
      setupNeeded: true,
      problem: `OAuth token file ${tokenFile} does not contain an access_token.`,
    };
  }
  if (!usable(token.refresh_token)) {
    // Renewal throws this exact message once the access token expires, so a
    // token file without a refresh token is an hour away from failing.
    return {
      setupNeeded: true,
      problem: `No refresh token found in ${tokenFile}. Run npm run oauth:setup from the plugin directory.`,
    };
  }
  return { setupNeeded: false };
}

/**
 * Validates `ZENDESK_OAUTH_CALLBACK_PORT` exactly as `oauth:setup` reads it,
 * then asks whether the loopback port is free. The default probe only binds
 * `127.0.0.1` briefly; no traffic leaves the machine. A port that cannot be
 * bound gets its own advice: only a port another process holds is evidence of
 * an earlier setup still waiting for authorization.
 */
async function checkCallbackPort(
  probe: (port: number) => Promise<PortProbeResult> = probePortFree,
): Promise<string | undefined> {
  const port = resolveCallbackPort();
  if (!isValidCallbackPort(port)) {
    return CALLBACK_PORT_ERROR;
  }
  const state = await probe(port);
  if (state === "free") return undefined;
  let cause: string;
  if (state === "in-use") {
    cause =
      "another process holds the port (often an earlier setup still waiting for authorization)";
  } else if (port < 1024) {
    cause = "this user cannot bind the port (a port below 1024 needs elevated privileges)";
  } else {
    // Above 1024 the port needs no privileges, so privileges are not the
    // explanation; a sandbox, a firewall, or an address policy can refuse it.
    cause = "this user cannot bind the port (the OS refused it to this user)";
  }
  return `npm run oauth:setup cannot listen on port ${port}: ${cause}. Set ZENDESK_OAUTH_CALLBACK_PORT to a free port and register that exact callback URL on the OAuth client in Zendesk.`;
}

/** What the loopback bind attempt found; only `EADDRINUSE` means "held". */
function probePortFree(port: number): Promise<PortProbeResult> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", (error: NodeJS.ErrnoException) =>
      resolve(error.code === "EADDRINUSE" ? "in-use" : "unavailable"),
    );
    probe.listen(port, "127.0.0.1", () => {
      // Both calls run in this one callback, so no connection can slip in
      // between them: without destroy-then-close, a socket accepted in the
      // probe window would stall close(), and with it the doctor's output.
      probe.closeAllConnections();
      probe.close();
      resolve("free");
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
