import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { getConfig, resolveCallbackPort, type ZendeskConfig } from "./auth.js";
import { assertUsableConfig } from "./health.js";
import { configuredTools } from "./policy.js";

/** The configuration fields the doctor inspects beyond startup validation. */
type DoctorConfig = Pick<ZendeskConfig, "baseUrl" | "mode" | "tokenFile">;

export interface DoctorOptions {
  /** Loads the OAuth configuration. Defaults to `getConfig`. */
  loadConfig?: () => DoctorConfig;
  /** Reports whether the loopback callback port can be bound. Defaults to a real bind. */
  probePort?: (port: number) => Promise<boolean>;
  /** Writes the all-clear line to stdout. */
  writeOut?: (line: string) => void;
  /** Writes one line per problem to stderr. */
  writeError?: (line: string) => void;
}

interface TokenFileState {
  /**
   * True when the stored token cannot be used and the remedy is to run
   * `npm run oauth:setup` again — the one problem whose fix needs the
   * callback port, so the port check runs for these states too.
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
 * actionable message per problem, in check order.
 *
 * Checks, in order: the OAuth configuration (the same validation startup
 * performs, including the client file's permission requirement), the tool
 * policy, the setup callback port, and the authorization-code token file. The
 * port and token-file checks run only in `authorization_code` mode, and the
 * port is checked only when the stored token is missing or unusable — those
 * are exactly the states where the remedy is running `npm run oauth:setup`,
 * which needs the port. A failing configuration skips the two dependent
 * checks, so a single run never repeats the same problem.
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
 * Runs the doctor preflight: one line per problem on stderr and exit 1, or a
 * single all-clear line on stdout and exit 0. The configuration and token-file
 * messages reuse the exact error strings startup produces (the port and
 * permission messages are doctor-only), and none of them carry credential
 * material.
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
 * Inspects the stored authorization-code token file. The unreadable,
 * unparseable, and incomplete-token messages reuse the exact strings startup
 * produces, so the troubleshooting table covers the doctor's output too. The
 * permission check is doctor-only: startup reads a token file without
 * inspecting its permissions.
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
  } catch {
    // Any stat failure — a missing file, or a path this user cannot read —
    // reuses startup's message and probes the port: both point the user at
    // re-running setup, which needs the port.
    return unreadable;
  }

  if (!isFile) {
    return {
      setupNeeded: false,
      problem: `OAuth token file ${tokenFile} is not a regular file.`,
    };
  }
  if ((mode & 0o077) !== 0) {
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
  if (!token.access_token) {
    return {
      setupNeeded: true,
      problem: `OAuth token file ${tokenFile} does not contain an access_token.`,
    };
  }
  if (!token.refresh_token) {
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
 * `127.0.0.1` briefly; no traffic leaves the machine.
 */
async function checkCallbackPort(
  probe: (port: number) => Promise<boolean> = probePortFree,
): Promise<string | undefined> {
  const port = resolveCallbackPort();
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "ZENDESK_OAUTH_CALLBACK_PORT must be an integer from 1 to 65535.";
  }
  if (await probe(port)) return undefined;
  return `npm run oauth:setup cannot listen on port ${port}: another process holds the port (often an earlier setup still waiting for authorization). Set ZENDESK_OAUTH_CALLBACK_PORT to a free port and register that exact callback URL on the OAuth client in Zendesk.`;
}

/** True when the loopback port can be bound right now. */
function probePortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => resolve(true));
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
