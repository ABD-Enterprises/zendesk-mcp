/**
 * Tests for the rate limiter that guards the file serving routes.
 *
 * Every value is invented: the files come from a temporary directory and the
 * console listens on 127.0.0.1, so nothing here reaches a live account or the
 * public internet. The limiter counts on a store the test owns, so the numbers
 * are exact and no test has to wait for a window to pass.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import express from "express";
import { mountStaticFiles, rateLimitSettings } from "../server.mjs";

const LIMIT = 3;
const WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 300;

const originalEnv = { ...process.env };

let distDir;

before(async () => {
  distDir = await mkdtemp(join(tmpdir(), "operations-console-static-"));
  await writeFile(
    join(distDir, "index.html"),
    "<!doctype html><title>invented console</title>",
    "utf8",
  );
});

after(async () => {
  await rm(distDir, { recursive: true, force: true });
});

afterEach(() => {
  process.env = { ...originalEnv };
});

/**
 * The store the limiter counts on.
 *
 * It counts the requests of every client inside the window the limiter hands
 * over, and forgets the counter of a client once that window has passed. The
 * clock is a function the test owns, so a window can pass without a test
 * waiting for it. A counter carries no reset time: the limiter then reports
 * the whole window as the time a client has to wait.
 */
class CountingStore {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.windowMs = null;
    this.hits = new Map();
    this.windows = new Map();
    this.keys = new Set();
    this.options = null;
  }

  init(options) {
    this.options = options;
    this.windowMs = options.windowMs;
  }

  increment(key) {
    this.keys.add(key);
    const now = this.now();
    const windowStart = this.windows.get(key);
    // A client that made no request inside the window starts a new one and
    // gets a full allowance again.
    const expired =
      windowStart === undefined ||
      (this.windowMs !== null && now - windowStart >= this.windowMs);
    if (expired) {
      this.windows.set(key, now);
      this.hits.set(key, 1);
      return { totalHits: 1, resetTime: undefined };
    }
    const totalHits = (this.hits.get(key) ?? 0) + 1;
    this.hits.set(key, totalHits);
    return { totalHits, resetTime: undefined };
  }

  decrement(key) {
    const totalHits = this.hits.get(key) ?? 0;
    if (totalHits > 0) this.hits.set(key, totalHits - 1);
  }

  resetKey(key) {
    this.hits.delete(key);
    this.windows.delete(key);
  }
}

// Starts the built frontend on 127.0.0.1 with an ephemeral port. The options
// are handed to the rate limiter, so a test chooses the limit and the window.
async function startStaticConsole(options = {}) {
  const target = express();
  const store = options.store ?? new CountingStore();
  const limiter = mountStaticFiles(target, { ...options, distDir, store });
  const server = target.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    limiter,
    store,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

test("serves the built file while the client stays within the limit", async () => {
  const consoleServer = await startStaticConsole({ limit: LIMIT });

  try {
    for (let attempt = 1; attempt <= LIMIT; attempt += 1) {
      const response = await fetch(`${consoleServer.baseUrl}/index.html`);

      assert.equal(response.status, 200, `request ${attempt} should be served`);
      assert.match(await response.text(), /invented console/);
    }
  } finally {
    await consoleServer.close();
  }
});

test("answers 429 when the client passes the limit", async () => {
  const consoleServer = await startStaticConsole({ limit: LIMIT });

  try {
    for (let attempt = 1; attempt <= LIMIT; attempt += 1) {
      const response = await fetch(`${consoleServer.baseUrl}/index.html`);

      assert.equal(response.status, 200, `request ${attempt} should be served`);
      await response.text();
    }

    const response = await fetch(`${consoleServer.baseUrl}/index.html`);

    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), String(WINDOW_MS / 1000));
    assert.deepEqual(await response.json(), {
      error: "Too many requests",
      retryAfterSeconds: WINDOW_MS / 1000,
    });
  } finally {
    await consoleServer.close();
  }
});

test("limits the single page fallback as well", async () => {
  const consoleServer = await startStaticConsole({ limit: LIMIT });

  try {
    for (let attempt = 1; attempt <= LIMIT; attempt += 1) {
      const response = await fetch(`${consoleServer.baseUrl}/dashboard`);

      assert.equal(response.status, 200, `request ${attempt} should be served`);
      assert.match(await response.text(), /invented console/);
    }

    const refused = await fetch(`${consoleServer.baseUrl}/dashboard`);

    assert.equal(refused.status, 429);
    await refused.text();
  } finally {
    await consoleServer.close();
  }
});

test("counts the requests of a client on its own", async () => {
  const consoleServer = await startStaticConsole({ limit: LIMIT });

  try {
    const response = await fetch(`${consoleServer.baseUrl}/index.html`);

    assert.equal(response.status, 200);
    await response.text();

    // The limiter keys the counter on the address of the client.
    assert.equal(consoleServer.store.keys.size, 1);
    const [key] = consoleServer.store.keys;
    assert.match(key, /127\.0\.0\.1$/);
    assert.equal(consoleServer.store.hits.get(key), 1);
  } finally {
    await consoleServer.close();
  }
});

test("starts a new allowance when the counter is reset", async () => {
  const consoleServer = await startStaticConsole({ limit: LIMIT });

  try {
    for (let attempt = 1; attempt <= LIMIT; attempt += 1) {
      const response = await fetch(`${consoleServer.baseUrl}/index.html`);

      assert.equal(response.status, 200);
      await response.text();
    }

    const refused = await fetch(`${consoleServer.baseUrl}/index.html`);

    assert.equal(refused.status, 429);
    await refused.text();

    // The counter of the client is forgotten, so the client may try again.
    const [key] = consoleServer.store.keys;
    await consoleServer.limiter.resetKey(key);

    const response = await fetch(`${consoleServer.baseUrl}/index.html`);

    assert.equal(response.status, 200);
    assert.match(await response.text(), /invented console/);
  } finally {
    await consoleServer.close();
  }
});

test("starts a new allowance when the window passes", async () => {
  process.env.ZENDESK_CONSOLE_RATE_LIMIT = "2";
  process.env.ZENDESK_CONSOLE_RATE_LIMIT_WINDOW_MS = "1500";

  // The clock of the store is a number the test moves by hand, so the window
  // passes without a test waiting for it.
  let now = 1_700_000_000_000;
  const store = new CountingStore({ now: () => now });
  const consoleServer = await startStaticConsole({ store });

  try {
    // The limiter counts with the limit and the window of the environment.
    assert.equal(store.options.limit, 2);
    assert.equal(store.options.windowMs, 1500);

    const first = await fetch(`${consoleServer.baseUrl}/index.html`);

    assert.equal(first.status, 200);
    await first.text();

    const second = await fetch(`${consoleServer.baseUrl}/index.html`);

    assert.equal(second.status, 200);
    await second.text();

    const refused = await fetch(`${consoleServer.baseUrl}/index.html`);

    assert.equal(refused.status, 429);
    await refused.text();

    // A window that has not passed yet does not give the client its
    // allowance back.
    now += 1499;
    const stillRefused = await fetch(`${consoleServer.baseUrl}/index.html`);

    assert.equal(stillRefused.status, 429);
    assert.equal(stillRefused.headers.get("retry-after"), "2");
    await stillRefused.text();

    // The window the environment names has passed now, so the client may try
    // again.
    now += 1;
    const allowed = await fetch(`${consoleServer.baseUrl}/index.html`);

    assert.equal(allowed.status, 200);
    assert.match(await allowed.text(), /invented console/);
  } finally {
    await consoleServer.close();
  }
});

test("reads the limit and the window from the environment", async () => {
  process.env.ZENDESK_CONSOLE_RATE_LIMIT = "2";
  process.env.ZENDESK_CONSOLE_RATE_LIMIT_WINDOW_MS = "1500";

  const consoleServer = await startStaticConsole();

  try {
    // The limiter runs with the limit and the window from the environment.
    assert.equal(consoleServer.store.options.limit, 2);
    assert.equal(consoleServer.store.options.windowMs, 1500);

    const first = await fetch(`${consoleServer.baseUrl}/index.html`);

    assert.equal(first.status, 200);
    assert.equal(first.headers.get("x-ratelimit-limit"), "2");
    await first.text();

    const second = await fetch(`${consoleServer.baseUrl}/index.html`);

    assert.equal(second.status, 200);
    await second.text();

    const refused = await fetch(`${consoleServer.baseUrl}/index.html`);

    assert.equal(refused.status, 429);
    await refused.text();
  } finally {
    await consoleServer.close();
  }
});

test("keeps a generous default limit", async () => {
  delete process.env.ZENDESK_CONSOLE_RATE_LIMIT;
  delete process.env.ZENDESK_CONSOLE_RATE_LIMIT_WINDOW_MS;

  const consoleServer = await startStaticConsole();

  try {
    assert.equal(consoleServer.store.options.limit, DEFAULT_LIMIT);
    assert.equal(consoleServer.store.options.windowMs, WINDOW_MS);
  } finally {
    await consoleServer.close();
  }
});

test("falls back to the default when the environment is malformed", async () => {
  process.env.ZENDESK_CONSOLE_RATE_LIMIT = "not a number";
  process.env.ZENDESK_CONSOLE_RATE_LIMIT_WINDOW_MS = "0";

  const consoleServer = await startStaticConsole();

  try {
    assert.equal(consoleServer.store.options.limit, DEFAULT_LIMIT);
    assert.equal(consoleServer.store.options.windowMs, WINDOW_MS);
  } finally {
    await consoleServer.close();
  }
});

test("maps the environment onto the limit and the window", () => {
  process.env.ZENDESK_CONSOLE_RATE_LIMIT = "7";
  process.env.ZENDESK_CONSOLE_RATE_LIMIT_WINDOW_MS = "1500";

  assert.deepEqual(rateLimitSettings(), { limit: 7, windowMs: 1500 });
});

test("keeps the default limit and window for a malformed environment", () => {
  process.env.ZENDESK_CONSOLE_RATE_LIMIT = "not a number";
  process.env.ZENDESK_CONSOLE_RATE_LIMIT_WINDOW_MS = "0";

  assert.deepEqual(rateLimitSettings(), {
    limit: DEFAULT_LIMIT,
    windowMs: WINDOW_MS,
  });
});

test("starts the built frontend on 127.0.0.1 with an ephemeral port", async () => {
  const consoleServer = await startStaticConsole({ limit: LIMIT });

  try {
    assert.match(consoleServer.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

    const response = await fetch(`${consoleServer.baseUrl}/index.html`);

    assert.equal(response.status, 200);
    await response.text();
  } finally {
    await consoleServer.close();
  }
});

test("leaves the routes that were mounted before it alone", async () => {
  const target = express();
  const store = new CountingStore();
  target.get("/api/status", (_request, response) => response.json({ ok: true }));
  mountStaticFiles(target, { distDir, store, limit: 1 });
  const server = target.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // The first file request uses up the whole allowance.
    const first = await fetch(`${baseUrl}/index.html`);

    assert.equal(first.status, 200);
    await first.text();

    const refused = await fetch(`${baseUrl}/index.html`);

    assert.equal(refused.status, 429);
    await refused.text();

    // The route that was mounted before the limiter still answers.
    const status = await fetch(`${baseUrl}/api/status`);

    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { ok: true });
  } finally {
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});
