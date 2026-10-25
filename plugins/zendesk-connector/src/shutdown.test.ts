import assert from "node:assert/strict";
import { test } from "node:test";
import type { ShutdownLogEvent } from "./audit.js";
import {
  installShutdownHandlers,
  resolveShutdownTimeoutMs,
  type ShutdownOptions,
  type ShutdownSignal,
} from "./shutdown.js";

interface FakeTimer {
  callback: () => void;
  milliseconds: number;
  cancelled: boolean;
}

function fakeTimers() {
  const timers: FakeTimer[] = [];
  return {
    timers,
    schedule(callback: () => void, milliseconds: number): NodeJS.Timeout {
      const timer: FakeTimer = { callback, milliseconds, cancelled: false };
      timers.push(timer);
      return timer as unknown as NodeJS.Timeout;
    },
    cancel(handle: NodeJS.Timeout): void {
      (handle as unknown as FakeTimer).cancelled = true;
    },
    fire(): void {
      for (const timer of timers) {
        if (!timer.cancelled) timer.callback();
      }
    },
  };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Installs handlers without touching the real process signal handlers. */
function install(
  options: Pick<ShutdownOptions, "close" | "log" | "exit"> &
    Partial<Omit<ShutdownOptions, "close" | "log" | "exit">> & {
      schedule: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
      cancel: (handle: NodeJS.Timeout) => void;
    },
) {
  return installShutdownHandlers({
    onSignal: () => {},
    offSignal: () => {},
    ...options,
  });
}

test("closes the server once and exits zero on the first signal", async () => {
  const timers = fakeTimers();
  const events: ShutdownLogEvent[] = [];
  const exits: number[] = [];
  let closeCalls = 0;

  const handle = install({
    close: () => {
      closeCalls += 1;
    },
    log: (event) => events.push(event),
    exit: (code) => exits.push(code),
    schedule: timers.schedule,
    cancel: timers.cancel,
  });

  handle.handleSignal("SIGINT");
  await nextTick();

  assert.equal(closeCalls, 1);
  assert.deepEqual(exits, [0]);
  assert.deepEqual(events, [{ trigger: "sigint", exitCode: 0 }]);
  assert.equal(timers.timers[0].cancelled, true);
});

test("exits zero after a graceful SIGTERM shutdown", async () => {
  const timers = fakeTimers();
  const events: ShutdownLogEvent[] = [];
  const exits: number[] = [];

  const handle = install({
    close: async () => {},
    log: (event) => events.push(event),
    exit: (code) => exits.push(code),
    schedule: timers.schedule,
    cancel: timers.cancel,
  });

  handle.handleSignal("SIGTERM");
  await nextTick();

  assert.deepEqual(exits, [0]);
  assert.deepEqual(events, [{ trigger: "sigterm", exitCode: 0 }]);
});

test("a second signal exits immediately with the conventional code", () => {
  const timers = fakeTimers();
  const events: ShutdownLogEvent[] = [];
  const exits: number[] = [];
  let closeCalls = 0;

  const handle = install({
    close: () => {
      closeCalls += 1;
      return new Promise<void>(() => {});
    },
    log: (event) => events.push(event),
    exit: (code) => exits.push(code),
    schedule: timers.schedule,
    cancel: timers.cancel,
  });

  handle.handleSignal("SIGINT");
  handle.handleSignal("SIGINT");

  assert.equal(closeCalls, 1);
  assert.deepEqual(exits, [130]);
  assert.deepEqual(events, [{ trigger: "second-signal", exitCode: 130 }]);
});

test("a second SIGTERM exits immediately with 143", () => {
  const timers = fakeTimers();
  const exits: number[] = [];

  const handle = install({
    close: () => new Promise<void>(() => {}),
    log: () => {},
    exit: (code) => exits.push(code),
    schedule: timers.schedule,
    cancel: timers.cancel,
  });

  handle.handleSignal("SIGTERM");
  handle.handleSignal("SIGTERM");

  assert.deepEqual(exits, [143]);
});

test("the in-flight shutdown cannot log or exit again after a second signal", async () => {
  const timers = fakeTimers();
  const events: ShutdownLogEvent[] = [];
  const exits: number[] = [];
  let finishClose: (() => void) | undefined;

  const handle = install({
    close: () =>
      new Promise<void>((resolve) => {
        finishClose = resolve;
      }),
    log: (event) => events.push(event),
    exit: (code) => exits.push(code),
    schedule: timers.schedule,
    cancel: timers.cancel,
  });

  handle.handleSignal("SIGINT");
  handle.handleSignal("SIGTERM");
  assert.equal(timers.timers[0].cancelled, true);

  finishClose?.();
  await nextTick();
  timers.fire();

  assert.deepEqual(exits, [143]);
  assert.deepEqual(events, [{ trigger: "second-signal", exitCode: 143 }]);
});

test("the watchdog force-exits with code 1 when the shutdown hangs", () => {
  const timers = fakeTimers();
  const events: ShutdownLogEvent[] = [];
  const exits: number[] = [];
  let closeCalls = 0;

  const handle = install({
    close: () => {
      closeCalls += 1;
      return new Promise<void>(() => {});
    },
    log: (event) => events.push(event),
    exit: (code) => exits.push(code),
    schedule: timers.schedule,
    cancel: timers.cancel,
  });

  handle.handleSignal("SIGTERM");
  timers.fire();

  assert.equal(closeCalls, 1);
  assert.deepEqual(exits, [1]);
  assert.deepEqual(events, [{ trigger: "timeout", exitCode: 1 }]);
});

test("a failing close exits with code 1", async () => {
  const timers = fakeTimers();
  const events: ShutdownLogEvent[] = [];
  const exits: number[] = [];

  const handle = install({
    close: async () => {
      throw new Error("close failed");
    },
    log: (event) => events.push(event),
    exit: (code) => exits.push(code),
    schedule: timers.schedule,
    cancel: timers.cancel,
  });

  handle.handleSignal("SIGINT");
  await nextTick();

  assert.deepEqual(exits, [1]);
  assert.deepEqual(events, [{ trigger: "sigint", exitCode: 1 }]);
});

test("registers and removes SIGINT and SIGTERM handlers", () => {
  const registered: ShutdownSignal[] = [];
  const removed: ShutdownSignal[] = [];

  const handle = installShutdownHandlers({
    close: () => {},
    log: () => {},
    exit: () => {},
    onSignal: (signal) => registered.push(signal),
    offSignal: (signal) => removed.push(signal),
  });

  assert.deepEqual(registered, ["SIGINT", "SIGTERM"]);

  handle.dispose();

  assert.deepEqual(removed, ["SIGINT", "SIGTERM"]);
});

test("reads the watchdog timeout from the environment", () => {
  assert.equal(resolveShutdownTimeoutMs({}), 5000);
  assert.equal(
    resolveShutdownTimeoutMs({ ZENDESK_SHUTDOWN_TIMEOUT_MS: "1200" }),
    1200,
  );
  assert.equal(
    resolveShutdownTimeoutMs({ ZENDESK_SHUTDOWN_TIMEOUT_MS: "not-a-number" }),
    5000,
  );
  assert.equal(
    resolveShutdownTimeoutMs({ ZENDESK_SHUTDOWN_TIMEOUT_MS: "0" }),
    5000,
  );
});

test("arms the watchdog with the configured timeout", () => {
  const timers = fakeTimers();

  install({
    close: () => new Promise<void>(() => {}),
    log: () => {},
    exit: () => {},
    timeoutMs: 250,
    schedule: timers.schedule,
    cancel: timers.cancel,
  }).handleSignal("SIGINT");

  assert.equal(timers.timers[0].milliseconds, 250);
});
