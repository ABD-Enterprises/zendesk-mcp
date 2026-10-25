import { getConfig, OAUTH_MODES } from "./auth.js";

export interface HealthCheckOk {
  healthcheck: "ok";
}

export interface HealthCheckFail {
  healthcheck: "fail";
  error: string;
}

export type HealthCheckResult = HealthCheckOk | HealthCheckFail;

export interface HealthCheckOptions {
  /** Loads the OAuth configuration. Defaults to `getConfig`. */
  loadConfig?: () => unknown;
  /** Writes the result line to stdout. */
  writeOut?: (line: string) => void;
  /** Writes the result line to stderr. */
  writeError?: (line: string) => void;
}

/** Reports whether the process was asked to run a healthcheck only. */
export function isHealthCheckRequested(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (argv.includes("--healthcheck")) return true;
  const flag = env.ZENDESK_HEALTHCHECK?.trim().toLowerCase();
  return flag === "1" || flag === "true";
}

/**
 * Validates the OAuth configuration without contacting Zendesk. The failure
 * reason comes from the thrown error message, which never carries credential
 * material.
 */
export function checkHealth(
  loadConfig: () => unknown = getConfig,
): HealthCheckResult {
  try {
    assertUsableConfig(loadConfig());
    return { healthcheck: "ok" };
  } catch (error) {
    return {
      healthcheck: "fail",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Runs the healthcheck, writes one JSON line, and returns the exit code. */
export function runHealthCheck(options: HealthCheckOptions = {}): number {
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

  const result = checkHealth(options.loadConfig ?? getConfig);
  if (result.healthcheck === "ok") {
    writeOut(`${JSON.stringify(result)}\n`);
    return 0;
  }
  writeError(`${JSON.stringify(result)}\n`);
  return 1;
}

function assertUsableConfig(config: unknown): void {
  if (!config || typeof config !== "object") {
    throw new Error("Zendesk OAuth configuration is missing.");
  }
  const candidate = config as { baseUrl?: unknown; mode?: unknown };
  if (typeof candidate.baseUrl !== "string" || candidate.baseUrl.trim() === "") {
    throw new Error("Zendesk OAuth configuration has no base URL.");
  }
  if (
    typeof candidate.mode !== "string" ||
    !(OAUTH_MODES as readonly string[]).includes(candidate.mode)
  ) {
    throw new Error("Zendesk OAuth configuration has no supported mode.");
  }
}
