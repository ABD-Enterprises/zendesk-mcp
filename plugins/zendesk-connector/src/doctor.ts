import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { getConfig, type ZendeskConfig } from "./auth.js";
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
  /** True when the token file could be stat'ed (it exists, whatever state it is in). */
  exists: boolean;
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
 * port is checked only before setup has stored a token — afterwards nothing
 * listens on it. A failing configuration skips the two dependent checks, so a
 * single run never repeats the same problem.
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
    if (!token.exists) {
      const portProblem = await checkCallbackPort(options.probePort);
      if (portProblem) problems.push(portProblem);
    }
    if (token.problem) problems.push(token.problem);
  }

  return problems;
}

/**
 * Runs the doctor preflight: one line per problem on stderr and exit 1, or a
 * single all-clear line on stdout and exit 0. The messages come from the same
 * error strings startup uses, so they never carry credential material.
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
 * Inspects the stored authorization-code token file. The read failures reuse
 * the exact messages startup produces, so the troubleshooting table covers the
 * doctor's output too. The permission check is doctor-only: startup reads a
 * token file without inspecting its permissions.
 */
function inspectTokenFile(tokenFile: string): TokenFileState {
  let mode: number;
  let isFile: boolean;
  try {
    const stats = statSync(tokenFile);
    mode = stats.mode;
    isFile = stats.isFile();
  } catch (error) {
    const missing =
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      exists: !missing,
      problem: `Unable to read OAuth token file ${tokenFile}. Run npm run oauth:setup from the plugin directory.`,
    };
  }

  if (!isFile) {
    return {
      exists: true,
      problem: `OAuth token file ${tokenFile} is not a regular file.`,
    };
  }
  if ((mode & 0o077) !== 0) {
    return {
      exists: true,
      problem: `OAuth token file ${tokenFile} must be readable only by its owner (chmod 600).`,
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(tokenFile, "utf8"));
  } catch {
    return {
      exists: true,
      problem: `Unable to read OAuth token file ${tokenFile}. Run npm run oauth:setup from the plugin directory.`,
    };
  }
  if (!payload || typeof payload !== "object") {
    return {
      exists: true,
      problem: `OAuth token file ${tokenFile} does not contain an access_token.`,
    };
  }
  if (!(payload as { access_token?: unknown }).access_token) {
    return {
      exists: true,
      problem: `OAuth token file ${tokenFile} does not contain an access_token.`,
    };
  }
  return { exists: true };
}

/**
 * Validates `ZENDESK_OAUTH_CALLBACK_PORT` exactly as `oauth:setup` reads it,
 * then asks whether the loopback port is free. The default probe only binds
 * `127.0.0.1` briefly; no traffic leaves the machine.
 */
async function checkCallbackPort(
  probe: (port: number) => Promise<boolean> = probePortFree,
): Promise<string | undefined> {
  const port = Number(process.env.ZENDESK_OAUTH_CALLBACK_PORT ?? 3219);
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
