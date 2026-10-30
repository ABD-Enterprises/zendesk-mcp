import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import {
  CALLBACK_PORT_ERROR,
  getConfig,
  isValidCallbackPort,
  oauthClientFilePath,
  resolveCallbackPort,
  sameFilePath,
  type ZendeskConfig,
} from "./auth.js";
import { assertUsableConfig } from "./health.js";
import { configuredTools, toolNames } from "./policy.js";

/** The configuration fields the doctor inspects beyond startup validation. */
type DoctorConfig = Pick<
  ZendeskConfig,
  "baseUrl" | "mode" | "tokenFile" | "scope"
>;

/** What the loopback port probe found when it tried to bind. */
export type PortProbeResult =
  /** The port binds right now. */
  | "free"
  /** Another process already holds the port. */
  | "in-use"
  /** The port cannot be bound at all (for example a privileged port). */
  | UnavailablePort;

/** A bind refusal that is not another process holding the port. */
export interface UnavailablePort {
  /** The OS errno (`EACCES`, `EMFILE`, ...), when one was reported. */
  errno?: string;
}

export interface DoctorOptions {
  /** Loads the OAuth configuration. Defaults to `getConfig`. */
  loadConfig?: () => DoctorConfig;
  /**
   * Reports whether the loopback callback port can be bound, and why not.
   * Defaults to a real bind.
   */
  probePort?: (port: number) => Promise<PortProbeResult>;
  /**
   * Prints the resolved configuration and the enabled tools, so an operator
   * can see what the agent will receive without starting the server.
   */
  tools?: boolean;
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
   * where the file belongs, loose permissions, a file this user cannot
   * open) set it to false: their report names the path or permissions to
   * repair directly — a fix that needs no callback port — even though
   * re-running setup would also replace the file.
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

/** Reports whether the process was asked to print the tool inventory. */
export function isToolsRequested(
  argv: string[] = process.argv.slice(2),
): boolean {
  return argv.includes("--tools");
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
 * or an all-clear line on stdout and exit 0. The configuration messages
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
    // The tool result does not name the token file any more, so the doctor is
    // where the operator learns where the token lives. The path is filesystem
    // information for the person running it, never credential material.
    const tokenFile = tokenFileOf(options);
    if (tokenFile) writeOut(`OAuth token file: ${tokenFile}\n`);
  } else {
    for (const problem of problems) writeError(`${problem}\n`);
  }
  if (options.tools) writeInventory(options, writeOut);
  return problems.length === 0 ? 0 : 1;
}

/**
 * Prints the resolved configuration and the enabled tools.
 *
 * Without it an operator cannot confirm what the agent will receive: the
 * tool policy is read from the environment, and the only way to see the
 * result was to start the server and list its tools.
 */
function writeInventory(
  options: DoctorOptions,
  writeOut: (line: string) => void,
): void {
  let loaded;
  try {
    loaded = (options.loadConfig ?? getConfig)();
  } catch {
    // The checks already reported what is wrong with the configuration, so
    // the inventory says what it could not do — the configuration, not the
    // tools.
    writeOut("The configuration could not be resolved.\n");
    return;
  }
  writeOut(`Base URL: ${loaded.baseUrl}\n`);
  writeOut(`OAuth mode: ${loaded.mode}\n`);
  writeOut(`Scope: ${loaded.scope}\n`);
  // The scope the account granted and the token's expiry. The scope above is
  // the one the connector asks for; only the stored token says what it was
  // given, and reading it asks the account nothing.
  const stored = storedTokenDetails(loaded);
  if (stored.scope) writeOut(`Granted scope: ${stored.scope}\n`);
  if (stored.expiresAt) writeOut(`Token expires: ${stored.expiresAt}\n`);
  try {
    const enabled = [...configuredTools()].sort();
    writeOut(
      `Enabled tools (${enabled.length} of ${toolNames().length}): ${enabled.join(", ")}\n`,
    );
  } catch {
    // The tool policy is broken, but the configuration above is what the
    // operator asked for, so it is printed anyway.
    writeOut("The enabled tools could not be resolved.\n");
  }
}

/**
 * The granted scope and the expiry of the stored token.
 *
 * The client-credentials mode stores no token — it asks the account for one
 * per request — so there is nothing to report for it. A token file that
 * cannot be read is reported by the checks, and the inventory leaves the
 * lines out rather than repeating the problem.
 */
function storedTokenDetails(config: DoctorConfig): {
  scope?: string;
  expiresAt?: string;
} {
  if (config.mode !== "authorization_code") return {};
  try {
    const payload = JSON.parse(readFileSync(config.tokenFile, "utf8")) as {
      scope?: unknown;
      expires_at?: unknown;
    };
    return {
      scope: typeof payload.scope === "string" ? payload.scope : undefined,
      expiresAt:
        typeof payload.expires_at === "string" ? payload.expires_at : undefined,
    };
  } catch {
    return {};
  }
}

/** The token file of a configuration that passed the checks, if it has one. */
function tokenFileOf(options: DoctorOptions): string | undefined {
  try {
    const loaded = (options.loadConfig ?? getConfig)();
    return loaded.mode === "authorization_code" ? loaded.tokenFile : undefined;
  } catch {
    // The problems already say what is wrong with the configuration.
    return undefined;
  }
}

/**
 * Inspects the stored authorization-code token file: first that its path is
 * not the OAuth client file, then its file state (present, a regular file,
 * owner-only permissions), then its contents (parseable JSON with an
 * `access_token` and a `refresh_token`).
 *
 * The missing-file, unparseable, and incomplete-token messages reuse the
 * exact strings startup produces, so the troubleshooting table covers the
 * doctor's output too. The other messages (the client-file path, unreadable
 * path, not a regular file, permissions) are the doctor's own: startup reads
 * the token file without inspecting it, and the permission check is
 * additionally skipped on Windows, where Node reports synthetic permission
 * bits.
 */
function inspectTokenFile(tokenFile: string): TokenFileState {
  // The same guard logout applies: if the token path is the client file,
  // re-running setup would write the token over the client credentials.
  // The remedy is fixing the path, not setup, so no port is probed. Files
  // are compared by device and inode, so a case-variant or symlinked
  // spelling of the client file cannot slip past on a case-insensitive
  // volume.
  if (sameFilePath(tokenFile, oauthClientFilePath())) {
    return {
      setupNeeded: false,
      problem: `OAuth token file ${tokenFile} is the OAuth client file. Set ZENDESK_OAUTH_TOKEN_FILE to a different path, or fix the client file's tokenFile field; oauth:setup would overwrite the client credentials.`,
    };
  }

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

  let raw: string;
  try {
    raw = readFileSync(tokenFile, "utf8");
  } catch (error) {
    // stat succeeded, so the path exists and the failure is the open itself
    // (an unreadable file). Only ENOENT — the file vanished between stat and
    // read — still means setup never stored a token; a refusal to open is a
    // permissions problem whose remedy is fixing the file's access, and the
    // port a setup re-run would need is not probed for it.
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
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Unparseable means the stored token is unusable and oauth:setup
    // replaces the file, so its remedy applies — and so does its port.
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
  } else {
    // The errno names the refusal (EACCES, EMFILE, EADDRNOTAVAIL, ...), so
    // the report carries the OS's own cause instead of only a guess at one.
    const detail = state.errno === undefined ? "" : `, errno ${state.errno}`;
    cause =
      port < 1024
        ? // Elevation would fix a privilege refusal (EACCES), but not every
          // errno a low-port bind can report — EMFILE or ENFILE is
          // descriptor exhaustion — so the errno still rides along and
          // names the cause when privileges are not it.
          `this user cannot bind the port (a port below 1024 needs elevated privileges${detail})`
        : // Above 1024 the port needs no privileges, so privileges are not
          // the explanation; a sandbox, a firewall, an address policy, or
          // descriptor exhaustion (EMFILE, ENFILE) can refuse the bind, and
          // the errno names which — so this clause claims no cause of its own.
          `this user cannot bind the port (the OS refused the bind attempt${detail})`;
  }
  return `npm run oauth:setup cannot listen on port ${port}: ${cause}. Set ZENDESK_OAUTH_CALLBACK_PORT to a free port and register that exact callback URL on the OAuth client in Zendesk.`;
}

/** What the loopback bind attempt found; only `EADDRINUSE` means "held". */
function probePortFree(port: number): Promise<PortProbeResult> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", (error: NodeJS.ErrnoException) =>
      resolve(error.code === "EADDRINUSE" ? "in-use" : { errno: error.code }),
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
