import type { ShutdownLogEvent, ShutdownTrigger } from "./audit.js";

/** The termination signals the server reacts to. */
export type ShutdownSignal = "SIGINT" | "SIGTERM";

export interface ShutdownOptions {
  /** Closes the MCP server, which closes its transport. */
  close: () => Promise<void> | void;
  /** Receives the structured shutdown event. */
  log: (event: ShutdownLogEvent) => void;
  /** Terminates the process with the given exit code. */
  exit: (code: number) => void;
  /** Watchdog timeout in milliseconds. Defaults to the environment, then 5000. */
  timeoutMs?: number;
  /** Registers a signal handler. Defaults to `process.on`. */
  onSignal?: (signal: ShutdownSignal, handler: () => void) => void;
  /** Removes a signal handler. Defaults to `process.off`. */
  offSignal?: (signal: ShutdownSignal, handler: () => void) => void;
  /** Schedules the watchdog. Defaults to `setTimeout`. */
  schedule?: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  /** Cancels the watchdog. Defaults to `clearTimeout`. */
  cancel?: (handle: NodeJS.Timeout) => void;
}

export interface ShutdownHandle {
  /** Runs the shutdown sequence for a signal. */
  handleSignal: (signal: ShutdownSignal) => void;
  /** Removes the registered signal handlers. */
  dispose: () => void;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;
const SIGINT_EXIT_CODE = 130;
const SIGTERM_EXIT_CODE = 143;

/**
 * Installs graceful shutdown handlers for SIGINT and SIGTERM. The first signal
 * closes the server and exits zero, a second signal exits immediately with the
 * conventional 128 + signal code, and a watchdog exits with code 1 when the
 * shutdown hangs.
 */
export function installShutdownHandlers(
  options: ShutdownOptions,
): ShutdownHandle {
  const timeoutMs = options.timeoutMs ?? resolveShutdownTimeoutMs();
  const schedule =
    options.schedule ??
    ((callback: () => void, milliseconds: number) =>
      setTimeout(callback, milliseconds));
  const cancel =
    options.cancel ??
    ((handle: NodeJS.Timeout) => {
      clearTimeout(handle);
    });
  const onSignal =
    options.onSignal ??
    ((signal: ShutdownSignal, handler: () => void) => {
      process.on(signal, handler);
    });
  const offSignal =
    options.offSignal ??
    ((signal: ShutdownSignal, handler: () => void) => {
      process.off(signal, handler);
    });

  let shuttingDown = false;
  let exited = false;
  let watchdog: NodeJS.Timeout | undefined;

  const handleSignal = (signal: ShutdownSignal): void => {
    if (shuttingDown) {
      if (exited) return;
      exited = true;
      if (watchdog) cancel(watchdog);
      const exitCode =
        signal === "SIGINT" ? SIGINT_EXIT_CODE : SIGTERM_EXIT_CODE;
      options.log({ trigger: "second-signal", exitCode });
      options.exit(exitCode);
      return;
    }
    shuttingDown = true;

    const trigger: ShutdownTrigger = signal === "SIGINT" ? "sigint" : "sigterm";
    watchdog = schedule(() => {
      exited = true;
      options.log({ trigger: "timeout", exitCode: 1 });
      options.exit(1);
    }, timeoutMs);

    const finish = (exitCode: number): void => {
      if (exited) return;
      exited = true;
      if (watchdog) cancel(watchdog);
      options.log({ trigger, exitCode });
      options.exit(exitCode);
    };

    let closing: Promise<void> | void;
    try {
      closing = options.close();
    } catch {
      finish(1);
      return;
    }
    void Promise.resolve(closing).then(
      () => finish(0),
      () => finish(1),
    );
  };

  const handlers: Record<ShutdownSignal, () => void> = {
    SIGINT: () => handleSignal("SIGINT"),
    SIGTERM: () => handleSignal("SIGTERM"),
  };
  onSignal("SIGINT", handlers.SIGINT);
  onSignal("SIGTERM", handlers.SIGTERM);

  return {
    handleSignal,
    dispose: () => {
      offSignal("SIGINT", handlers.SIGINT);
      offSignal("SIGTERM", handlers.SIGTERM);
    },
  };
}

/** Reads the watchdog timeout from the environment, falling back to 5000 ms. */
export function resolveShutdownTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.ZENDESK_SHUTDOWN_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }
  return parsed;
}
