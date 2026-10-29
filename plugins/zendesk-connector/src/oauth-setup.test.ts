import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { OAuthClientFile, StoredToken, ZendeskConfig } from "./auth.js";
import {
  authorizeWithBrowser,
  callbackServerPort,
  createReadlinePrompter,
  isMainModule,
  openBrowser,
  runOAuthSetup,
  type BrowserSpawn,
  type OAuthSetupOptions,
  type Prompter,
} from "./oauth-setup.js";

const originalEnv = { ...process.env };
// Temporary fixture directories are tracked so each test removes its own.
const tempDirs: string[] = [];

/** The host environment without any account configuration. */
function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...originalEnv };
  for (const name of Object.keys(env)) {
    if (name.startsWith("ZENDESK_")) delete env[name];
  }
  return { ...env, ...extra };
}

afterEach(async () => {
  process.env = { ...originalEnv };
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** Creates a temporary fixture directory that `afterEach` removes. */
async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zendesk-oauth-setup-test-"));
  tempDirs.push(directory);
  return directory;
}

/** The token the fake authorization hands back. */
const fakeToken: StoredToken = {
  access_token: "example-access-token",
  refresh_token: "example-refresh-token",
  token_type: "bearer",
  scope: "tickets:read",
};

/** A setup run's captured output and the calls it made. */
interface RunResult {
  code: number;
  out: string[];
  err: string[];
  questions: string[];
  /** Whether each question in `questions` asked with `mask: true`. */
  masks: boolean[];
  authorizations: { baseUrl: string; redirectUri: string }[];
}

/** Runs a setup with scripted answers and captured output. */
async function runSetup(
  options: {
    answers?: string[];
    interactive?: boolean;
    authorize?: OAuthSetupOptions["authorize"];
    loadConfig?: OAuthSetupOptions["loadConfig"];
    saveClientFile?: OAuthSetupOptions["saveClientFile"];
  } = {},
): Promise<RunResult> {
  const answers = [...(options.answers ?? [])];
  const questions: string[] = [];
  const masks: boolean[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const authorizations: { baseUrl: string; redirectUri: string }[] = [];

  const setupOptions: OAuthSetupOptions = {
    prompt: async (question, promptOptions) => {
      questions.push(question);
      masks.push(promptOptions?.mask === true);
      const answer = answers.shift();
      if (answer === undefined) {
        throw new Error(`no scripted answer for the question: ${question}`);
      }
      return answer;
    },
    isInteractive: () => options.interactive ?? true,
    authorize:
      options.authorize ??
      (async (config, redirectUri) => {
        authorizations.push({ baseUrl: config.baseUrl, redirectUri });
        return fakeToken;
      }),
    writeOut: (line) => out.push(line),
    writeError: (line) => err.push(line),
  };
  if (options.loadConfig) setupOptions.loadConfig = options.loadConfig;
  if (options.saveClientFile) setupOptions.saveClientFile = options.saveClientFile;

  const code = await runOAuthSetup(setupOptions);

  return { code, out, err, questions, masks, authorizations };
}

/** The paths a test's sandboxed client and token files live at. */
interface Sandbox {
  directory: string;
  clientFile: string;
  tokenFile: string;
}

/**
 * Prepares a sandbox and points the environment at it. The client file
 * exists but holds nothing, so the real one is never read.
 */
async function sandbox(env: NodeJS.ProcessEnv = {}): Promise<Sandbox> {
  const directory = await tempDir();
  const clientFile = join(directory, "client.json");
  const tokenFile = join(directory, "oauth.json");
  await writeFile(clientFile, "{}", { mode: 0o600 });
  process.env = cleanEnv({
    ZENDESK_OAUTH_CLIENT_FILE: clientFile,
    ZENDESK_OAUTH_TOKEN_FILE: tokenFile,
    ...env,
  });
  return { directory, clientFile, tokenFile };
}

/**
 * Asserts that a file the setup wrote is owner-only. On Windows there is
 * nothing to assert: Node reports synthetic permission bits there (0666 for
 * a writable file) regardless of the file's ACLs, which is why the
 * connector's own client-file check is skipped on Windows too. The rest of
 * the calling test keeps running either way — this guard returns instead of
 * calling `ctx.skip()`, because a mid-test skip downgrades every later
 * assertion failure in that test to a skip.
 */
async function assertOwnerOnly(file: string): Promise<void> {
  if (process.platform === "win32") return;
  const stats = await stat(file);
  assert.equal(stats.mode & 0o777, 0o600);
}

test("runs the browser flow without prompting when everything is configured", async () => {
  const files = await sandbox({
    ZENDESK_SUBDOMAIN: "acme-tools",
    ZENDESK_OAUTH_CLIENT_ID: "example-client-id",
    ZENDESK_OAUTH_CLIENT_SECRET: "example-client-secret",
  });
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];

  const code = await runOAuthSetup({
    prompt: async (question) => {
      asked.push(question);
      throw new Error("a configured run must not prompt");
    },
    authorize: async () => fakeToken,
    writeOut: (line) => out.push(line),
    writeError: (line) => err.push(line),
  });

  assert.equal(code, 0);
  assert.deepEqual(asked, []);
  assert.deepEqual(err, []);
  assert.deepEqual(out, [`Zendesk OAuth tokens saved to ${files.tokenFile}\n`]);

  const stored = JSON.parse(await readFile(files.tokenFile, "utf8"));
  assert.deepEqual(stored, fakeToken);
  await assertOwnerOnly(files.tokenFile);
});

test("prompts for every missing value and saves what the user entered", async () => {
  const files = await sandbox();
  const result = await runSetup({
    answers: ["acme-tools", "example-client-id", "example-client-secret", "y"],
  });

  assert.equal(result.code, 0);
  assert.deepEqual(result.err, []);
  assert.equal(result.questions.length, 4);
  assert.match(result.questions[0], /^Zendesk subdomain/);
  assert.match(result.questions[1], /^OAuth client id/);
  assert.match(result.questions[2], /^OAuth client secret/);
  assert.ok(result.questions[3].startsWith(`Save these values to ${files.clientFile}`));
  // Only the client secret is asked for masked; the subdomain, the client id,
  // and the save question are not secrets and must not be hidden.
  assert.deepEqual(result.masks, [false, false, true, false]);

  // The client file holds the three entered fields and owner-only
  // permissions.
  const client = JSON.parse(await readFile(files.clientFile, "utf8"));
  assert.deepEqual(client, {
    subdomain: "acme-tools",
    clientId: "example-client-id",
    clientSecret: "example-client-secret",
  });
  await assertOwnerOnly(files.clientFile);

  const token = JSON.parse(await readFile(files.tokenFile, "utf8"));
  assert.deepEqual(token, fakeToken);
  assert.equal(result.authorizations.length, 1);
  assert.equal(result.authorizations[0].baseUrl, "https://acme-tools.zendesk.com");
  assert.equal(
    result.authorizations[0].redirectUri,
    "http://127.0.0.1:3219/callback",
  );
});

test("keeps the client file untouched when the user declines to save", async () => {
  const files = await sandbox();
  const result = await runSetup({
    answers: ["acme-tools", "example-client-id", "example-client-secret", "n"],
  });

  assert.equal(result.code, 0);
  assert.equal(await readFile(files.clientFile, "utf8"), "{}");
  const token = JSON.parse(await readFile(files.tokenFile, "utf8"));
  assert.deepEqual(token, fakeToken);
});

test("merges the entered values into an existing client file", async () => {
  const files = await sandbox();
  await writeFile(
    files.clientFile,
    JSON.stringify({ scope: "tickets:read tickets:write" }),
    { mode: 0o600 },
  );

  const result = await runSetup({
    answers: ["acme-tools", "example-client-id", "example-client-secret", "y"],
  });

  assert.equal(result.code, 0);
  const client = JSON.parse(await readFile(files.clientFile, "utf8"));
  assert.deepEqual(client, {
    scope: "tickets:read tickets:write",
    subdomain: "acme-tools",
    clientId: "example-client-id",
    clientSecret: "example-client-secret",
  });
});

test("asks only for the values that are missing", async () => {
  await sandbox({ ZENDESK_SUBDOMAIN: "acme-tools" });
  const result = await runSetup({
    answers: ["example-client-id", "example-client-secret", "n"],
  });

  assert.equal(result.code, 0);
  assert.equal(result.questions.length, 3);
  assert.match(result.questions[0], /^OAuth client id/);
  assert.match(result.questions[1], /^OAuth client secret/);
  assert.ok(result.questions[2].startsWith("Save these values to"));
  assert.ok(
    !result.questions.some((question) => question.startsWith("Zendesk subdomain")),
  );
});

test("reports the missing values when the run cannot prompt", async () => {
  const files = await sandbox();
  const result = await runSetup({ interactive: false, answers: [] });

  assert.equal(result.code, 1);
  assert.deepEqual(result.out, []);
  assert.deepEqual(result.questions, []);
  assert.equal(result.err.length, 2);
  assert.equal(
    result.err[0],
    `Zendesk OAuth setup needs the Zendesk subdomain, the OAuth client id and the OAuth client secret. Set ZENDESK_SUBDOMAIN (or ZENDESK_BASE_URL), ZENDESK_OAUTH_CLIENT_ID and ZENDESK_OAUTH_CLIENT_SECRET, or add "subdomain" (or "baseUrl"), "clientId" and "clientSecret" to ${files.clientFile}.\n`,
  );
  assert.equal(
    result.err[1],
    "Run npm run doctor to check the configuration.\n",
  );

  // The failure is one clean line per problem: no stack trace.
  for (const line of result.err) {
    assert.ok(!/\s+\n/.test(line), "each failure line is a single line");
    assert.doesNotMatch(line, / at .*\(.*:\d+:\d+\)/);
  }
});

test("names the two missing values when the account and the secret are missing", async () => {
  const files = await sandbox({ ZENDESK_OAUTH_CLIENT_ID: "example-client-id" });
  const result = await runSetup({ interactive: false, answers: [] });

  assert.equal(result.code, 1);
  assert.equal(result.err.length, 2);
  // The two values are listed the same way the three values are: the list
  // reads as one sentence.
  assert.equal(
    result.err[0],
    `Zendesk OAuth setup needs the Zendesk subdomain and the OAuth client secret. Set ZENDESK_SUBDOMAIN (or ZENDESK_BASE_URL) and ZENDESK_OAUTH_CLIENT_SECRET, or add "subdomain" (or "baseUrl") and "clientSecret" to ${files.clientFile}.\n`,
  );
  assert.equal(
    result.err[1],
    "Run npm run doctor to check the configuration.\n",
  );
});

test("refuses client_credentials mode without prompting", async () => {
  await sandbox({ ZENDESK_OAUTH_MODE: "client_credentials" });
  const result = await runSetup();

  assert.equal(result.code, 1);
  assert.deepEqual(result.questions, []);
  assert.equal(
    result.err[0],
    "oauth:setup is only for authorization_code mode. Remove ZENDESK_OAUTH_MODE or set it to authorization_code.\n",
  );
  assert.equal(
    result.err[1],
    "Run npm run doctor to check the configuration.\n",
  );
});

test("refuses an unknown OAuth mode without prompting", async () => {
  await sandbox({ ZENDESK_OAUTH_MODE: "implicit" });
  const result = await runSetup();

  assert.equal(result.code, 1);
  assert.deepEqual(result.questions, []);
  assert.equal(
    result.err[0],
    "ZENDESK_OAUTH_MODE must be authorization_code, client_credentials, or access_token.\n",
  );
  assert.equal(
    result.err[1],
    "Run npm run doctor to check the configuration.\n",
  );
});

test("refuses access_token mode without prompting", async () => {
  const files = await sandbox({ ZENDESK_OAUTH_MODE: "access_token" });
  const result = await runSetup();

  assert.equal(result.code, 1);
  assert.deepEqual(result.questions, []);
  assert.equal(
    result.err[0],
    "oauth:setup is only for authorization_code mode. Remove ZENDESK_OAUTH_MODE or set it to authorization_code.\n",
  );
  assert.equal(
    result.err[1],
    "Run npm run doctor to check the configuration.\n",
  );
  // The setup never ran, so no token file was written.
  await assert.rejects(() => readFile(files.tokenFile, "utf8"));
});

test("refuses an access token without a mode without prompting", async () => {
  const files = await sandbox({
    ZENDESK_OAUTH_ACCESS_TOKEN: "example-access-token",
  });
  const result = await runSetup();

  assert.equal(result.code, 1);
  assert.deepEqual(result.questions, []);
  assert.equal(
    result.err[0],
    "oauth:setup is only for authorization_code mode. Remove ZENDESK_OAUTH_ACCESS_TOKEN to run setup.\n",
  );
  assert.equal(
    result.err[1],
    "Run npm run doctor to check the configuration.\n",
  );
  // The setup never ran, so no token file was written.
  await assert.rejects(() => readFile(files.tokenFile, "utf8"));
});

test("asks again when the account answer is not a subdomain", async () => {
  await sandbox();
  const result = await runSetup({
    answers: [
      "bad value!!!",
      "https://not a url",
      "acme-tools",
      "example-client-id",
      "example-client-secret",
      "n",
    ],
  });

  assert.equal(result.code, 0);
  assert.equal(result.questions.length, 6);
  assert.match(result.questions[0], /^Zendesk subdomain/);
  assert.match(result.questions[1], /^Zendesk subdomain/);
  assert.match(result.questions[2], /^Zendesk subdomain/);
  // The message belongs to the prompt: it names no environment variable and
  // does not repeat the answer.
  for (const line of result.err) {
    assert.equal(
      line,
      "Not a valid Zendesk subdomain or URL (for example acme-tools or https://acme-tools.zendesk.com).\n",
    );
    assert.doesNotMatch(line, /ZENDESK_/);
    assert.doesNotMatch(line, /bad value|not a url/);
  }
  assert.equal(
    result.authorizations[0].baseUrl,
    "https://acme-tools.zendesk.com",
  );
});

test("cancels the run when the first answer is empty", async () => {
  const files = await sandbox();
  const result = await runSetup({ answers: [""] });

  assert.equal(result.code, 1);
  assert.deepEqual(result.questions.length, 1);
  // A cancellation is not a configuration problem, so it carries no hint.
  assert.deepEqual(result.err, [
    "Setup cancelled: no Zendesk subdomain was entered.\n",
  ]);
  assert.ok(!result.err.join("").includes("npm run doctor"));
  assert.equal(await readFile(files.clientFile, "utf8"), "{}");
  await assert.rejects(() => readFile(files.tokenFile, "utf8"));
});

test("names the field that was left empty when the run is cancelled", async () => {
  await sandbox();
  const withoutId = await runSetup({ answers: ["acme-tools", ""] });

  assert.equal(withoutId.code, 1);
  assert.deepEqual(withoutId.err, [
    "Setup cancelled: no OAuth client id was entered.\n",
  ]);

  const withoutSecret = await runSetup({
    answers: ["acme-tools", "example-client-id", ""],
  });

  assert.equal(withoutSecret.code, 1);
  assert.deepEqual(withoutSecret.err, [
    "Setup cancelled: no OAuth client secret was entered.\n",
  ]);
});

test("reports a closed terminal instead of a stack trace", async () => {
  await sandbox();
  const out: string[] = [];
  const err: string[] = [];

  const code = await runOAuthSetup({
    prompt: async () => {
      const error = new Error("Aborted with Ctrl+D");
      (error as { code?: string }).code = "ABORT_ERR";
      throw error;
    },
    isInteractive: () => true,
    authorize: async () => fakeToken,
    writeOut: (line) => out.push(line),
    writeError: (line) => err.push(line),
  });

  assert.equal(code, 1);
  assert.deepEqual(out, []);
  // The closed prompt is a cancellation too, so it carries no hint.
  assert.deepEqual(err, [
    "Setup cancelled: the prompt was closed before the setup finished.\n",
  ]);
  assert.ok(!err.join("").includes("npm run doctor"));
});

test("refuses an unusable callback port without prompting", async () => {
  await sandbox({ ZENDESK_OAUTH_CALLBACK_PORT: "abc" });
  const result = await runSetup();

  assert.equal(result.code, 1);
  assert.deepEqual(result.questions, []);
  assert.equal(
    result.err[0],
    "ZENDESK_OAUTH_CALLBACK_PORT must be an integer from 1 to 65535, written as decimal digits (for example 3219).\n",
  );
  assert.equal(
    result.err[1],
    "Run npm run doctor to check the configuration.\n",
  );
});

test("derives the listened callback port from the redirect URI", () => {
  // The listener has to bind the port the browser is sent to. The URL parser
  // normalizes a default port away — an http URI carrying :80 reads back an
  // empty `.port` — so deriving the port any other way would bind an
  // ephemeral port while the redirect URI still says :80, and the run would
  // sit out its five-minute timeout on a port nothing serves. Every port the
  // setup can build therefore round-trips through the derivation.
  for (const port of [1, 80, 443, 3219, 65535]) {
    assert.equal(
      callbackServerPort(`http://127.0.0.1:${port}/callback`),
      port,
    );
  }
  // A URI with no port at all falls back to the scheme's own default.
  assert.equal(callbackServerPort("https://127.0.0.1/callback"), 443);
  assert.equal(callbackServerPort("http://127.0.0.1/callback"), 80);
});

test("keeps an explicit :80 in the redirect URI the listener binds", async () => {
  // The URL parser erases an explicit default port, so this pins the two
  // halves against each other: the redirect URI setup hands to the authorize
  // step still names :80, and the port the listener derives from that URI is
  // 80 rather than an ephemeral one. (The listener itself is not started —
  // the authorize step is injected — so this runs without binding a
  // privileged port.)
  await sandbox({
    ZENDESK_SUBDOMAIN: "acme-tools",
    ZENDESK_OAUTH_CLIENT_ID: "example-client-id",
    ZENDESK_OAUTH_CLIENT_SECRET: "example-client-secret",
    ZENDESK_OAUTH_CALLBACK_PORT: "80",
  });
  const result = await runSetup();

  assert.equal(result.code, 0);
  assert.equal(result.authorizations.length, 1);
  const redirectUri = result.authorizations[0].redirectUri;
  assert.equal(redirectUri, "http://127.0.0.1:80/callback");
  assert.equal(callbackServerPort(redirectUri), 80);
});

/**
 * Binds `port` on the loopback once and reports what happened: `null` when
 * it bound, or the errno it failed with. The privileged-port test below can
 * only show a permission refusal on a host that refuses one, so it asks
 * this first — root, Windows, and unusual sysctl settings can all bind
 * port 80, and there the refusal never happens.
 */
async function probeBind(port: number): Promise<string | null> {
  const probe = createServer();
  return new Promise<string | null>((resolve) => {
    probe.once("error", (error: Error) =>
      resolve((error as NodeJS.ErrnoException).code ?? "unknown"),
    );
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => resolve(null));
    });
  });
}

/**
 * A browser launcher that records the arguments it is called with and
 * starts nothing: a test of the callback server can assert the run never
 * reaches it (so a regression opens no real browser), or assert what the
 * launcher was actually handed on the path that must reach it.
 */
function recordingSpawn(opened: string[]): BrowserSpawn {
  return (_command, args) => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => {};
    opened.push(...args);
    return child;
  };
}

test("refuses to authorize on a port the host will not bind", async (ctx) => {
  // The redirect URI names :80, and the listener has to bind that exact
  // port: a run whose listener is elsewhere would print an authorization
  // URL for a port nothing serves and sit out its five-minute timeout. On a
  // host that refuses port 80 the bind itself fails, and that refusal — not
  // a timeout — is what the user sees. If the listening port were derived
  // from the URI in a way that lost the :80 (the URL parser reads it back as
  // an empty `.port`), the listener would bind an ephemeral port instead,
  // this assertion would fail, and fail immediately: the listen callback
  // refuses any port that disagrees with the redirect URI before anything is
  // printed or opened. This test bounds that timeout to four seconds, so
  // even a doubly-regressed run — no guard and no correct derivation — fails
  // in seconds rather than waiting out the production five minutes.
  const probe = await probeBind(80);
  if (probe !== "EACCES" && probe !== "EPERM") {
    ctx.skip(
      probe === null
        ? "this host can bind port 80, so it cannot show a refusal"
        : `port 80 fails with ${probe} on this host, not a permission refusal`,
    );
    return;
  }

  const files = await sandbox();
  const config: ZendeskConfig = {
    baseUrl: "https://acme-tools.zendesk.com",
    mode: "authorization_code",
    clientId: "example-client-id",
    clientSecret: "example-client-secret",
    tokenFile: files.tokenFile,
    scope: "read",
  };
  const out: string[] = [];
  const opened: string[] = [];

  await assert.rejects(
    authorizeWithBrowser(
      config,
      "http://127.0.0.1:80/callback",
      (line) => out.push(line),
      recordingSpawn(opened),
      4_000,
    ),
    (error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "EACCES" || code === "EPERM";
    },
  );
  // The refusal happens before the authorization URL is written out and
  // before any browser is started.
  assert.deepEqual(out, []);
  assert.deepEqual(opened, []);
});

test("refuses a redirect URI whose port the listener cannot hold", async () => {
  // Port 0 asks the OS for an ephemeral port, which by construction is never
  // the port the URI names. The listen callback compares what it bound with
  // what the URI says and fails the run on any disagreement, so this rejects
  // with the named mismatch — promptly, and before the authorization URL is
  // printed or the browser opened. The launcher is a recording stub, so if
  // the bound-port check were ever removed the test would still fail (at
  // the callback timeout, bounded here to four seconds) without ever
  // starting a real browser.
  const files = await sandbox();
  const config: ZendeskConfig = {
    baseUrl: "https://acme-tools.zendesk.com",
    mode: "authorization_code",
    clientId: "example-client-id",
    clientSecret: "example-client-secret",
    tokenFile: files.tokenFile,
    scope: "read",
  };
  const out: string[] = [];
  const opened: string[] = [];

  await assert.rejects(
    authorizeWithBrowser(
      config,
      "http://127.0.0.1:0/callback",
      (line) => out.push(line),
      recordingSpawn(opened),
      4_000,
    ),
    /bound port \d+ instead of the port in the redirect URI \(0\)/,
  );
  assert.deepEqual(out, []);
  assert.deepEqual(opened, []);
});

/**
 * Binds an ephemeral loopback port and releases it, returning the number.
 * The positive-path test below needs a port this host has just agreed to
 * bind, which is the closest thing to a guarantee that it can bind it
 * again a moment later.
 */
async function freePort(): Promise<number> {
  const probe = createServer();
  return new Promise<number>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

test("opens the authorization URL through the injected launcher", async () => {
  // The positive path: the redirect URI names a port this host can bind, the
  // listener holds it, and the run reaches the launcher — which has to be
  // the injected stub, so nothing is ever opened. Were the injection to
  // regress, the real launcher would run instead: the test still fails,
  // because only the stub records anything — but on a developer's machine
  // that regression opens the authorization URL in a real browser, which is
  // why the seam is asserted from both directions. The callback then
  // arrives with the wrong state on purpose: the run fails on the state
  // check before the token exchange, so there is no network call and no
  // wait for the callback deadline.
  const files = await sandbox();
  const config: ZendeskConfig = {
    baseUrl: "https://acme-tools.zendesk.com",
    mode: "authorization_code",
    clientId: "example-client-id",
    clientSecret: "example-client-secret",
    tokenFile: files.tokenFile,
    scope: "read",
  };
  const port = await freePort();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const out: string[] = [];
  const opened: string[] = [];
  // The handler is attached at once: a listener that never comes up leaves
  // its error in the outcome instead of an unhandled rejection. The wait is
  // bounded below the poll deadline, so a run that reaches no launcher ends
  // with its own reason instead of leaving the production five-minute timer
  // to hold the suite open after the assertion fails.
  let ended = false;
  const outcome = authorizeWithBrowser(
    config,
    redirectUri,
    (line) => out.push(line),
    recordingSpawn(opened),
    4_000,
  ).then(
    () => {
      ended = true;
      return undefined;
    },
    (error: unknown) => {
      ended = true;
      return error;
    },
  );

  // The launcher runs from the listen callback, so waiting for it doubles as
  // waiting for the listener. The loop also stops once the run has ended:
  // an early failure (a bind refusal, say) then reports its own error below
  // instead of being masked by this deadline. The deadline is the last
  // resort, for a run that neither calls the launcher nor ends.
  const deadline = Date.now() + 5_000;
  while (opened.length === 0 && !ended) {
    if (Date.now() > deadline) {
      throw new Error("the injected launcher was never called");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (opened.length === 0) {
    // The loop only leaves with the launcher recorded or the run ended, so
    // here the run ended before any launcher call: its own error says why.
    const failure = await outcome;
    assert.ok(failure instanceof Error);
    // A wait that ran out means the launcher was never reached — the deadline
    // above would say the same thing — so report that directly; anything
    // else (a bind refusal, a port mismatch) is the real reason and stands.
    if (!failure.message.includes("Timed out")) throw failure;
    throw new Error("the injected launcher was never called");
  }
  // The launcher was handed the authorization URL, and its redirect_uri is
  // the port the listener actually holds — the same URI the browser would
  // be sent back to.
  const authorizeUrl = opened.find((arg) => arg.startsWith("http"));
  assert.ok(authorizeUrl !== undefined);
  assert.equal(
    new URL(authorizeUrl).searchParams.get("redirect_uri"),
    redirectUri,
  );
  assert.equal(
    opened.filter((arg) => arg.startsWith("http")).length,
    1,
  );

  // A callback with the wrong state: the server refuses it with 400 and
  // fails the run. The connection is one-off (no keep-alive), so the suite
  // can exit without waiting for an idle socket.
  const status = await new Promise<number>((resolve, reject) => {
    const request = get(
      `http://127.0.0.1:${port}/callback?code=example-code&state=not-the-state`,
      { agent: false },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
  });
  assert.equal(status, 400);

  const error = await outcome;
  assert.ok(error instanceof Error);
  assert.match(error.message, /missing a valid code or state/);
  // The authorization URL was printed exactly once — after the port check
  // passed and before the launcher ran.
  assert.equal(
    out.filter((line) => line.startsWith("Opening Zendesk authorization:"))
      .length,
    1,
  );
});

/**
 * Drives the browser-authorization flow as far as the token exchange and
 * returns the run's rejection. The fetch stub answers the exchange with the
 * given body and refuses every other URL, so a flow that grows another call
 * fails the test instead of reaching the real network. The launcher is
 * injected, so nothing is ever opened.
 */
async function exchangeFailure(
  body: string,
  contentType: string,
  responseStatus = 200,
): Promise<{
  error: Error;
  out: string[];
  requests: string[];
}> {
  const files = await sandbox();
  const config: ZendeskConfig = {
    baseUrl: "https://acme-tools.zendesk.com",
    mode: "authorization_code",
    clientId: "example-client-id",
    clientSecret: "example-client-secret",
    tokenFile: files.tokenFile,
    scope: "read",
  };
  const port = await freePort();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const out: string[] = [];
  const opened: string[] = [];
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    requests.push(url);
    // Fail closed: the exchange is the only call this flow makes today, so
    // any other URL is a change this test has not agreed to — and answering
    // it would put a real request on the wire to a plausible real host.
    assert.ok(
      url.endsWith("/oauth/tokens"),
      `unexpected network call from the flow: ${url}`,
    );
    // The body is encoded to bytes the way a network response arrives: a
    // string body would make the Response constructor append its own
    // text/plain content type, which would make an absent content-type
    // header impossible to craft — and an empty one means just that.
    const headers = new Headers();
    if (contentType) headers.set("Content-Type", contentType);
    return new Response(new TextEncoder().encode(body), {
      status: responseStatus,
      headers,
    });
  }) as typeof fetch;

  // The scaffolding mirrors the positive-path test above: the launcher is
  // injected so nothing is opened, and the wait is bounded below the poll
  // deadline so a run that reaches no launcher ends with its own reason
  // instead of holding the suite open.
  let ended = false;
  const outcome = authorizeWithBrowser(
    config,
    redirectUri,
    (line) => out.push(line),
    recordingSpawn(opened),
    4_000,
  ).then(
    () => {
      ended = true;
      return undefined;
    },
    (error: unknown) => {
      ended = true;
      return error;
    },
  );

  try {
    const deadline = Date.now() + 5_000;
    while (opened.length === 0 && !ended) {
      if (Date.now() > deadline) {
        throw new Error("the injected launcher was never called");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (opened.length === 0) {
      // The loop only leaves with the launcher recorded or the run ended:
      // here the run ended before any launcher call, so its own error says
      // why. A wait that ran out means the launcher was never reached.
      const failure = await outcome;
      assert.ok(failure instanceof Error);
      if (!failure.message.includes("Timed out")) throw failure;
      throw new Error("the injected launcher was never called");
    }
    const authorizeUrl = opened.find((arg) => arg.startsWith("http"));
    assert.ok(authorizeUrl !== undefined);
    // The state the run generated, echoed back the way the browser would:
    // with it correct, the server accepts the code and proceeds to the
    // exchange the stub above is waiting to answer.
    const state = new URL(authorizeUrl).searchParams.get("state");
    assert.ok(state !== null);
    const status = await new Promise<number>((resolve, reject) => {
      const request = get(
        `http://127.0.0.1:${port}/callback?code=example-code&state=${encodeURIComponent(state)}`,
        { agent: false },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode ?? 0));
        },
      );
      request.once("error", reject);
    });
    // The server answers 200 the moment it has the code, before the exchange
    // runs — so the exchange's rejection is the run's own error, awaited by
    // the caller, not a status on this response.
    assert.equal(status, 200);

    const error = await outcome;
    assert.ok(error instanceof Error);
    return { error, out, requests };
  } finally {
    globalThis.fetch = originalFetch;
    // An assertion that throws before the callback is sent would otherwise
    // leave the flow's listener bound until its own four-second timeout,
    // holding a port open past the test's end. outcome never rejects — its
    // rejection is converted to a value above — so awaiting it here always
    // settles the run and closes the listener, bounded by that timeout.
    await outcome;
  }
}

test("never prints a token from a rejected token-exchange body", async () => {
  // The exchange can fail *after* Zendesk has already handed back a real
  // token: a 200 whose body is missing a refresh_token fails the shape
  // check, and stringifying that body as-is would put the access token into
  // the thrown error — where a caller may log or show it. This crafts
  // exactly that body, so the assertion pins what the filter does promise:
  // the keys it knows never reach the message. The client secret is
  // in the body too, the way a middlebox echoing the *request* would put it
  // there — so the assertion below binds to redact() rather than passing
  // because the secret was never present to begin with.
  const leakedToken = "example-access-token-must-not-be-printed";
  const { error, out, requests } = await exchangeFailure(
    JSON.stringify({
      access_token: leakedToken,
      client_secret: "example-client-secret",
      token_type: "bearer",
    }),
    "application/json",
  );

  assert.match(error.message, /Zendesk token exchange failed: HTTP 200/);
  // The message keeps the diagnosable shape but replaces the credential
  // material: the token and the client secret are both gone.
  assert.match(error.message, /\[REDACTED\]/);
  assert.ok(!error.message.includes(leakedToken));
  assert.ok(!error.message.includes("example-client-secret"));
  // Exactly the one expected call went out, and it was the exchange.
  assert.deepEqual(requests, ["https://acme-tools.zendesk.com/oauth/tokens"]);
  // The run reported the authorization URL exactly once, as in the flow
  // test above: the fix narrows what the error carries, not what the run
  // prints before it.
  assert.equal(
    out.filter((line) => line.startsWith("Opening Zendesk authorization:"))
      .length,
    1,
  );
});

test("describes a non-object exchange body by media type and size", async () => {
  // redact() works on object keys, so a body that never parsed into a JSON
  // object cannot be filtered by it — and a page that echoed the request
  // would carry the client secret and the one-time code. Such a body is
  // therefore named by its media type and size and nothing more.
  const leakedToken = "example-plaintext-token-must-not-be-printed";
  const body = `access_token=${leakedToken}`;
  const { error, requests } = await exchangeFailure(body, "text/plain");

  assert.match(error.message, /Zendesk token exchange failed: HTTP 200/);
  assert.ok(!error.message.includes(leakedToken));
  assert.ok(
    error.message.includes(
      `(non-object text/plain body of ${Buffer.byteLength(body, "utf8")} bytes)`,
    ),
  );
  assert.deepEqual(requests, ["https://acme-tools.zendesk.com/oauth/tokens"]);
});

test("never echoes the raw content of a rejected exchange body", async () => {
  // The branches the two tests above do not reach, each pinned against the
  // same expectation: whatever the rejected body's shape, the thrown error
  // carries its size, its media type, or its redacted form — and never its
  // raw content. The cases share one helper, so each still travels the
  // real browser flow.
  const leakedToken = "example-nested-token-must-not-be-printed";
  const cases: Array<{
    name: string;
    body: string;
    contentType: string;
    status?: number;
    shown: (body: string) => string;
  }> = [
    {
      // An empty body never reaches safeJson: the call site branches on
      // truthy text first, so the payload stays undefined and the note is
      // its own, with no size at all.
      name: "an empty body",
      body: "",
      contentType: "application/json",
      shown: () => "(empty body)",
    },
    {
      // A single byte, to pin the singular. The body is a bare character
      // that is not JSON, so safeJson falls back to the raw text and the
      // size note applies.
      name: "a one-byte body",
      body: "x",
      contentType: "text/plain",
      shown: () => "(non-object text/plain body of 1 byte)",
    },
    {
      // A non-ASCII body, with the count written out rather than
      // recomputed the way the implementation computes it: "é" is one
      // UTF-16 code unit and two utf-8 bytes, so a regression from
      // byteLength back to text.length would report 1 and fail here.
      name: "a non-ASCII body",
      body: "é",
      contentType: "text/plain",
      shown: () => "(non-object text/plain body of 2 bytes)",
    },
    {
      // A content type carrying parameters: only the media type is shown,
      // so a token a middlebox parked in the charset parameter cannot ride
      // along into the message.
      name: "a content type with parameters",
      body: "blocked by a proxy",
      contentType: "text/html; charset=utf-8",
      shown: () => "(non-object text/html body of 18 bytes)",
    },
    {
      // A content type past the length bound: nothing of it is shown. The
      // bound only keeps the echo small — a shorter token-shaped subtype
      // would still ride along — so past it the size is all the reader
      // gets.
      name: "an over-long content type",
      body: "blocked",
      contentType: `text/${"a".repeat(50)}`,
      shown: () => "(non-object body of 7 bytes)",
    },
    {
      // The bound's edge, held from both sides with one character of
      // difference: forty characters is shown, forty-one is not. The
      // subtype is all "a"s, so the count is the only thing that can
      // separate the two.
      name: "a content type at the length bound",
      body: "blocked",
      contentType: `text/${"a".repeat(35)}`,
      shown: () => `(non-object text/${"a".repeat(35)} body of 7 bytes)`,
    },
    {
      name: "a content type one past the bound",
      body: "blocked",
      contentType: `text/${"a".repeat(36)}`,
      shown: () => "(non-object body of 7 bytes)",
    },
    {
      // An upper-case media type: the header is lower-cased before it is
      // matched, so TEXT/PLAIN reaches the message as text/plain and case
      // alone cannot smuggle a differently-shaped value past the plain
      // type/subtype check.
      name: "an upper-case content type",
      body: "blocked",
      contentType: "TEXT/PLAIN; CHARSET=UTF-8",
      shown: () => "(non-object text/plain body of 7 bytes)",
    },
    {
      // redact() does recurse into arrays, so an array body would have its
      // keyed entries redacted. It takes the size note anyway: the shape
      // check rejects an array, and the guard at the call site keeps the
      // message to a size rather than a redacted list whose unkeyed values
      // redact() cannot filter.
      name: "a top-level array",
      body: JSON.stringify([{ access_token: leakedToken }]),
      contentType: "application/json",
      shown: (body) =>
        `(non-object application/json body of ${Buffer.byteLength(body, "utf8")} bytes)`,
    },
    {
      // A JSON null: an object to neither the shape check nor redact().
      name: "a JSON null",
      body: "null",
      contentType: "application/json",
      shown: (body) =>
        `(non-object application/json body of ${Buffer.byteLength(body, "utf8")} bytes)`,
    },
    {
      // The nested case the recursion in redact() exists for: the token is
      // two levels down, under a key that names it.
      name: "a nested token",
      body: JSON.stringify({
        data: { nested: { access_token: leakedToken } },
      }),
      contentType: "application/json",
      shown: () =>
        JSON.stringify({
          data: { nested: { access_token: "[REDACTED]" } },
        }),
    },
    {
      // A body carrying only the secret, with no token in it at all: the
      // first test's secret assertion shares a message with its token
      // assertion, so this case is what actually pins that a key the
      // filter knows is stripped on its own.
      name: "a secret with no token",
      body: JSON.stringify({
        error: "invalid_client",
        client_secret: "example-client-secret",
      }),
      contentType: "application/json",
      shown: () =>
        JSON.stringify({
          error: "invalid_client",
          client_secret: "[REDACTED]",
        }),
    },
    {
      // A rejected status with a JSON error body: the non-ok branch takes
      // the same path, and the status reaches the message intact.
      name: "a non-ok JSON error",
      body: JSON.stringify({
        error: "invalid_grant",
        access_token: leakedToken,
      }),
      contentType: "application/json",
      status: 401,
      shown: () =>
        JSON.stringify({ error: "invalid_grant", access_token: "[REDACTED]" }),
    },
    {
      // A JSON echo of the exchange request itself: the shared filter
      // strips the secret, and the call site drops the pair the filter may
      // not match — the one-time code and the client id beside it. The
      // error description the reader actually needs is left alone.
      name: "a JSON echo of the request",
      body: JSON.stringify({
        error: "invalid_grant",
        error_description: "The code expired.",
        code: "example-one-time-code",
        client_id: "example-client-id",
        client_secret: "example-client-secret",
      }),
      contentType: "application/json",
      shown: () =>
        JSON.stringify({
          error: "invalid_grant",
          error_description: "The code expired.",
          client_secret: "[REDACTED]",
        }),
    },
    {
      // A body whose redacted echo runs past the echo bound: the first
      // bound-many characters of the echo, then the size. The cut is
      // expected literally rather than recomputed from the same constants
      // the implementation uses, so a regression that lifts the bound
      // leaves the full echo in the message and fails here.
      name: "an over-long JSON body",
      body: JSON.stringify({ error: "e".repeat(600) }),
      contentType: "application/json",
      shown: (body) =>
        `${JSON.stringify({ error: "e".repeat(600) }).slice(0, 512)}… (body of ${Buffer.byteLength(body, "utf8")} bytes)`,
    },
    {
      // An echo that runs past the bound with a surrogate pair sitting
      // exactly where a UTF-16 cut would fall: the emoji's high surrogate
      // is the 512th unit, so a cut by units would end the message in a
      // lone half. The expectation is written by code points — two whole
      // emoji survive the cut — so a regression to a unit cut fails here.
      name: "an over-long body ending mid-emoji",
      body: JSON.stringify({ a: "x".repeat(505) + "😀".repeat(5) }),
      contentType: "application/json",
      shown: (body) => {
        const points = [...JSON.stringify({ a: "x".repeat(505) + "😀".repeat(5) })];
        return `${points.slice(0, 512).join("")}… (body of ${Buffer.byteLength(body, "utf8")} bytes)`;
      },
    },
    {
      // No content-type header at all. The stub encodes the body to bytes
      // so the Response constructor does not append its own text/plain —
      // the way a real middlebox can answer without the header. The
      // media-type branch has nothing to show, and the size still reaches
      // the message.
      name: "a missing content type",
      body: "blocked by a proxy",
      contentType: "",
      shown: () => "(non-object body of 18 bytes)",
    },
  ];

  for (const testCase of cases) {
    const { error, requests } = await exchangeFailure(
      testCase.body,
      testCase.contentType,
      testCase.status,
    );
    assert.match(
      error.message,
      new RegExp(
        `^Zendesk token exchange failed: HTTP ${testCase.status ?? 200} `,
      ),
      testCase.name,
    );
    assert.ok(
      !error.message.includes(leakedToken),
      `${testCase.name} leaked the token: ${error.message}`,
    );
    assert.ok(
      error.message.includes(testCase.shown(testCase.body)),
      `${testCase.name} did not show the expected body: ${error.message}`,
    );
    assert.deepEqual(requests, ["https://acme-tools.zendesk.com/oauth/tokens"]);
  }
});

test("refuses a client file that other users can read", async (ctx) => {
  // Node reports synthetic permission bits on Windows (group and other always
  // look set), so the check is skipped there: this host cannot show the
  // refusal.
  if (process.platform === "win32") {
    ctx.skip("file mode bits are not reported the same way on Windows");
    return;
  }
  const files = await sandbox();
  await writeFile(
    files.clientFile,
    JSON.stringify({ subdomain: "acme-tools" }),
    { mode: 0o600 },
  );
  await chmod(files.clientFile, 0o644);
  const result = await runSetup();

  assert.equal(result.code, 1);
  assert.deepEqual(result.questions, []);
  assert.equal(
    result.err[0],
    `OAuth client configuration ${files.clientFile} must be readable only by its owner (chmod 600).\n`,
  );
  assert.equal(
    result.err[1],
    "Run npm run doctor to check the configuration.\n",
  );
  // The file the run refused to use is left exactly as it was.
  assert.equal(
    await readFile(files.clientFile, "utf8"),
    JSON.stringify({ subdomain: "acme-tools" }),
  );
});

test("reports a failed authorization without storing a token", async () => {
  const files = await sandbox({
    ZENDESK_SUBDOMAIN: "acme-tools",
    ZENDESK_OAUTH_CLIENT_ID: "example-client-id",
    ZENDESK_OAUTH_CLIENT_SECRET: "example-client-secret",
  });
  const result = await runSetup({
    authorize: async () => {
      throw new Error("Zendesk token exchange failed: HTTP 400");
    },
  });

  assert.equal(result.code, 1);
  assert.deepEqual(result.out, []);
  assert.equal(result.err.length, 2);
  assert.equal(result.err[0], "Zendesk token exchange failed: HTTP 400\n");
  assert.equal(
    result.err[1],
    "Run npm run doctor to check the configuration.\n",
  );
  await assert.rejects(() => readFile(files.tokenFile, "utf8"));
});

test("reports a client file that cannot be written", async () => {
  const files = await sandbox();
  const result = await runSetup({
    answers: ["acme-tools", "example-client-id", "example-client-secret", "y"],
    saveClientFile: async () => {
      throw new Error("EACCES: permission denied");
    },
  });

  assert.equal(result.code, 1);
  assert.equal(result.err[0], "EACCES: permission denied\n");
  assert.equal(
    result.err[1],
    "Run npm run doctor to check the configuration.\n",
  );
  // The run stopped before the authorization, so no token was stored.
  await assert.rejects(() => readFile(files.tokenFile, "utf8"));
});

test("stores a full account URL under the baseUrl field", async () => {
  const files = await sandbox();
  const result = await runSetup({
    answers: [
      "https://acme-tools.zendesk.com/",
      "example-client-id",
      "example-client-secret",
      "y",
    ],
  });

  assert.equal(result.code, 0);
  const client = JSON.parse(
    await readFile(files.clientFile, "utf8"),
  ) as Record<string, unknown>;
  const subdomain = client.subdomain;
  // A URL goes under "baseUrl": a reader that builds the URL from
  // "subdomain" would double the scheme. It is stored as its origin, so a
  // trailing slash cannot break a consumer that uses the field verbatim.
  assert.deepEqual(client, {
    baseUrl: "https://acme-tools.zendesk.com",
    clientId: "example-client-id",
    clientSecret: "example-client-secret",
  });
  assert.equal(subdomain, undefined);
  assert.equal(
    result.authorizations[0].baseUrl,
    "https://acme-tools.zendesk.com",
  );
});

test("stores the origin of an account URL that carries a path", async () => {
  const files = await sandbox();
  const result = await runSetup({
    answers: [
      "https://acme-tools.zendesk.com/agent",
      "example-client-id",
      "example-client-secret",
      "y",
    ],
  });

  assert.equal(result.code, 0);
  const client = JSON.parse(
    await readFile(files.clientFile, "utf8"),
  ) as Record<string, unknown>;
  assert.equal(client.baseUrl, "https://acme-tools.zendesk.com");
  assert.equal(
    result.authorizations[0].baseUrl,
    "https://acme-tools.zendesk.com",
  );
});

test("accepts an account URL whose scheme is not lowercase", async () => {
  const files = await sandbox();
  const result = await runSetup({
    answers: [
      "HTTPS://acme-tools.zendesk.com",
      "example-client-id",
      "example-client-secret",
      "y",
    ],
  });

  assert.equal(result.code, 0);
  // A scheme is case-insensitive, so the answer is a URL rather than a
  // subdomain: it is never rejected, and it is stored as its origin under
  // "baseUrl" the way any other URL answer is.
  const client = JSON.parse(
    await readFile(files.clientFile, "utf8"),
  ) as Record<string, unknown>;
  assert.equal(client.baseUrl, "https://acme-tools.zendesk.com");
  assert.equal(client.subdomain, undefined);
  assert.equal(
    result.authorizations[0].baseUrl,
    "https://acme-tools.zendesk.com",
  );
});

test("stores a bare subdomain under the subdomain field", async () => {
  const files = await sandbox();
  const result = await runSetup({
    answers: ["acme-tools", "example-client-id", "example-client-secret", "y"],
  });

  assert.equal(result.code, 0);
  const client = JSON.parse(
    await readFile(files.clientFile, "utf8"),
  ) as Record<string, unknown>;
  const baseUrl = client.baseUrl;
  assert.deepEqual(client, {
    subdomain: "acme-tools",
    clientId: "example-client-id",
    clientSecret: "example-client-secret",
  });
  assert.equal(baseUrl, undefined);
  assert.equal(
    result.authorizations[0].baseUrl,
    "https://acme-tools.zendesk.com",
  );
});

test("loads the configuration when the run is fully configured", async () => {
  const files = await sandbox({
    ZENDESK_SUBDOMAIN: "acme-tools",
    ZENDESK_OAUTH_CLIENT_ID: "example-client-id",
    ZENDESK_OAUTH_CLIENT_SECRET: "example-client-secret",
  });
  // The injected configuration differs from what the environment could
  // produce, so the run cannot pass with a configuration it built itself.
  const injectedTokenFile = join(files.directory, "injected-oauth.json");
  const config: ZendeskConfig = {
    baseUrl: "https://beta-tools.zendesk.com",
    mode: "authorization_code",
    clientId: "example-client-id",
    clientSecret: "example-client-secret",
    tokenFile: injectedTokenFile,
    scope: "tickets:read",
  };

  const result = await runSetup({ loadConfig: () => config });

  assert.equal(result.code, 0);
  assert.equal(result.authorizations.length, 1);
  // The authorization ran against the account the loaded configuration
  // names, not the one the environment names.
  assert.equal(
    result.authorizations[0].baseUrl,
    "https://beta-tools.zendesk.com",
  );
  assert.equal(
    result.authorizations[0].redirectUri,
    "http://127.0.0.1:3219/callback",
  );
  // The token went to the file the loaded configuration names, not to the one
  // the environment names.
  assert.deepEqual(
    JSON.parse(await readFile(injectedTokenFile, "utf8")),
    fakeToken,
  );
  await assert.rejects(() => readFile(files.tokenFile, "utf8"));
});

test("asks again when the save answer is not understood", async () => {
  await sandbox();
  const result = await runSetup({
    answers: [
      "acme-tools",
      "example-client-id",
      "example-client-secret",
      "maybe",
      "n",
    ],
  });

  assert.equal(result.code, 0);
  assert.equal(result.questions.length, 5);
  assert.ok(result.questions[3].startsWith("Save these values to"));
  assert.ok(result.questions[4].startsWith("Save these values to"));
  // The answer that was not understood is reported once, by a message that
  // names no environment variable and does not repeat the answer.
  assert.deepEqual(result.err, ["Please answer y or n.\n"]);
});

test("uses the values in the client file without prompting", async () => {
  const files = await sandbox();
  await writeFile(
    files.clientFile,
    JSON.stringify({
      subdomain: "acme-tools",
      clientId: "example-client-id",
      clientSecret: "example-client-secret",
    }),
    { mode: 0o600 },
  );
  const asked: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const authorizations: { baseUrl: string; redirectUri: string }[] = [];

  const code = await runOAuthSetup({
    prompt: async (question) => {
      asked.push(question);
      throw new Error("a configured run must not prompt");
    },
    authorize: async (config, redirectUri) => {
      authorizations.push({ baseUrl: config.baseUrl, redirectUri });
      return fakeToken;
    },
    writeOut: (line) => out.push(line),
    writeError: (line) => err.push(line),
  });

  assert.equal(code, 0);
  assert.deepEqual(asked, []);
  assert.deepEqual(err, []);
  assert.equal(authorizations.length, 1);
  assert.equal(authorizations[0].baseUrl, "https://acme-tools.zendesk.com");
  assert.deepEqual(
    JSON.parse(await readFile(files.tokenFile, "utf8")),
    fakeToken,
  );
});

test("removes the temporary file when the client file cannot be written", async () => {
  const directory = await tempDir();
  const clientFile = join(directory, "client.json");
  const tokenFile = join(directory, "oauth.json");
  process.env = cleanEnv({
    ZENDESK_OAUTH_CLIENT_FILE: clientFile,
    ZENDESK_OAUTH_TOKEN_FILE: tokenFile,
  });
  const answers = [
    "acme-tools",
    "example-client-id",
    "example-client-secret",
    "y",
  ];
  const err: string[] = [];
  const out: string[] = [];

  const code = await runOAuthSetup({
    prompt: async (question) => {
      const answer = answers.shift();
      if (answer === undefined) {
        throw new Error(`no scripted answer for the question: ${question}`);
      }
      if (answers.length === 3) {
        // The path turns into a directory while the reader answers, so the
        // rename fails after the temporary file was written.
        await mkdir(clientFile);
      }
      return answer;
    },
    isInteractive: () => true,
    authorize: async () => fakeToken,
    writeOut: (line) => out.push(line),
    writeError: (line) => err.push(line),
  });

  assert.equal(code, 1);
  assert.deepEqual(out, []);
  assert.equal(err.length, 2);
  assert.doesNotMatch(err[0], / at .*\(.*:\d+:\d+\)/);
  assert.equal(
    err[1],
    "Run npm run doctor to check the configuration.\n",
  );
  // The temporary file held the secret, so it is gone.
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
    [],
  );
  // The run stopped before the authorization, so no token was stored.
  await assert.rejects(() => readFile(tokenFile, "utf8"));
});

test("replaces a stale temporary file before writing the client file", async () => {
  const files = await sandbox();
  // The temporary name carries the process id, so the run can find it.
  const temporary = `${files.clientFile}.${process.pid}.tmp`;
  await writeFile(temporary, "stale contents\n", { mode: 0o600 });

  const result = await runSetup({
    answers: ["acme-tools", "example-client-id", "example-client-secret", "y"],
  });

  assert.equal(result.code, 0);
  const client = JSON.parse(await readFile(files.clientFile, "utf8"));
  assert.deepEqual(client, {
    subdomain: "acme-tools",
    clientId: "example-client-id",
    clientSecret: "example-client-secret",
  });
  // The stale entry is gone, so the client file holds the values and not
  // the stale contents.
  assert.deepEqual(
    (await readdir(files.directory)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("does not write the client secret through a link at the temporary name", async () => {
  const files = await sandbox();
  const temporary = `${files.clientFile}.${process.pid}.tmp`;
  const elsewhere = join(files.directory, "elsewhere.txt");
  await writeFile(elsewhere, "untouched\n", { mode: 0o600 });
  await symlink(elsewhere, temporary);

  const result = await runSetup({
    answers: ["acme-tools", "example-client-id", "example-client-secret", "y"],
  });

  assert.equal(result.code, 0);
  // The secret went into the client file, not through the link.
  assert.equal(await readFile(elsewhere, "utf8"), "untouched\n");
  const client = JSON.parse(await readFile(files.clientFile, "utf8"));
  assert.equal(client.clientSecret, "example-client-secret");
  assert.deepEqual(
    (await readdir(files.directory)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

/** A prompter wired to in-memory streams, with the output captured. */
function createPrompter(): {
  prompter: Prompter;
  input: PassThrough;
  output: PassThrough;
  captured: () => string;
} {
  const input = new PassThrough();
  const output = new PassThrough();
  // The width keeps readline's line refresh in shape.
  (output as PassThrough & { columns?: number }).columns = 80;
  let written = "";
  output.on("data", (chunk: Buffer | string) => {
    written += chunk.toString();
  });
  // Terminal mode is what gives readline a history to recall from, so the
  // prompter is exercised the way a real terminal exercises it.
  const prompter = createReadlinePrompter({ input, output, terminal: true });
  return { prompter, input, output, captured: () => written };
}

test("never writes a masked answer to the output", async () => {
  const { prompter, input, captured } = createPrompter();

  const secret = prompter.ask("OAuth client secret: ", { mask: true });
  input.write("example-client-secret\n");
  assert.equal(await secret, "example-client-secret");

  const next = prompter.ask("Save these values? [Y/n] ");
  input.write("y\n");
  assert.equal(await next, "y");

  // The secret is in neither the masked question nor the one after it.
  assert.ok(!captured().includes("example-client-secret"));
  assert.ok(captured().includes("OAuth client secret: "));
  prompter.close();
});

test("does not recall a typed value into the output", async () => {
  const { prompter, input, captured } = createPrompter();

  const secret = prompter.ask("OAuth client secret: ", { mask: true });
  input.write("example-client-secret\n");
  await secret;

  // The reader presses the up arrow, the way a terminal recalls the last
  // line. Nothing may come back: the secret must not be printable.
  input.write("\x1b[A");
  await new Promise((resolve) => setTimeout(resolve, 50));

  const next = prompter.ask("Save these values? [Y/n] ");
  input.write("y\n");
  await next;

  assert.ok(!captured().includes("example-client-secret"));
  prompter.close();
});

test("keeps a secret exactly as it was typed", async () => {
  const { prompter, input } = createPrompter();

  const secret = prompter.ask("OAuth client secret: ", { mask: true });
  input.write("  example client secret  \n");

  // A secret may begin or end with a space; only an empty answer is empty.
  assert.equal(await secret, "  example client secret  ");
  prompter.close();
});

test("close ends the prompt and refuses further questions", async () => {
  const { prompter, input } = createPrompter();

  const pending = prompter
    .ask("OAuth client secret: ", { mask: true })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  prompter.close();

  const failure = await pending;
  assert.ok(failure instanceof Error);
  assert.equal((failure as Error & { code?: string }).code, "ABORT_ERR");

  await assert.rejects(() => prompter.ask("Another question: "));
  // The interface is gone, so the input no longer reaches a question.
  input.write("example-client-secret\n");
});

/**
 * Asserts that a control character ends the pending question.
 *
 * The terminal closes the interface when the reader presses Ctrl+C or Ctrl+D,
 * and the pending question must fail instead of waiting for an answer that
 * never comes. The wait is raced against a short timer, so a regression fails
 * the test in seconds instead of hanging the run.
 */
async function assertControlEndsQuestion(control: string): Promise<void> {
  const { prompter, input } = createPrompter();

  const pending = prompter
    .ask("Zendesk subdomain (for example acme-tools): ")
    .then(
      () => undefined,
      (error: unknown) => error,
    );

  input.write(control);

  const failure = await Promise.race([
    pending,
    new Promise<undefined>((resolve) => {
      const late = setTimeout(() => resolve(undefined), 500);
      late.unref();
    }),
  ]);

  assert.ok(failure instanceof Error, "the pending question must fail");
  assert.equal((failure as Error & { code?: string }).code, "ABORT_ERR");

  // The prompt is closed, so a later question fails with the same abort error
  // instead of hanging on a dead interface.
  await assert.rejects(
    () => prompter.ask("Another question: "),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code?: string }).code, "ABORT_ERR");
      return true;
    },
  );
}

test("a closed terminal ends the pending question", async () => {
  // Ctrl+D ends the terminal.
  await assertControlEndsQuestion("\x04");
});

test("an interrupted terminal ends the pending question", async () => {
  // Ctrl+C interrupts the terminal, and readline closes the interface for
  // it, the same way it does for Ctrl+D.
  await assertControlEndsQuestion("\x03");
});

test("reports a browser that could not be opened on its own line", async () => {
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  let unrefed = false;
  child.unref = () => {
    unrefed = true;
  };
  const commands: { command: string; args: string[] }[] = [];
  const lines: string[] = [];
  const url = "https://example-tools.zendesk.com/oauth/authorizations/new";

  openBrowser(
    url,
    (line) => lines.push(line),
    (command, args) => {
      commands.push({ command, args });
      return child;
    },
  );

  assert.equal(commands.length, 1);
  assert.ok(commands[0].args.includes(url));
  // The parent walks away from the browser it started.
  assert.equal(unrefed, true);

  child.emit("error", new Error("spawn xdg-open ENOENT"));

  // The message is one line of its own: it carries the newline it needs.
  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith("\n"));
  assert.match(lines[0], /Could not open a browser automatically/);
});

test("lets the parent walk away from a browser it started", () => {
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  let unrefed = false;
  child.unref = () => {
    unrefed = true;
  };
  const lines: string[] = [];

  openBrowser(
    "https://example-tools.zendesk.com/oauth/authorizations/new",
    (line) => lines.push(line),
    () => child,
  );

  assert.equal(unrefed, true);
  // A browser that started says nothing.
  assert.deepEqual(lines, []);
});

test("recognises the entry point through its real path", async () => {
  const directory = await tempDir();
  const entry = join(directory, "oauth-setup.js");
  const other = join(directory, "other.js");
  await writeFile(entry, "// the entry point\n");

  // The file itself is the entry point.
  assert.equal(isMainModule(entry, entry), true);
  // A different file is not.
  assert.equal(isMainModule(other, entry), false);
});

test("recognises the entry point through a symlink", async () => {
  const directory = await tempDir();
  const entry = join(directory, "oauth-setup.js");
  const link = join(directory, "linked-oauth-setup.js");
  await writeFile(entry, "// the entry point\n");
  await symlink(entry, link);

  // The link names the same file, so the setup must run through it.
  assert.equal(isMainModule(link, entry), true);
});

test("reports no entry point for a path that cannot be resolved", async () => {
  const directory = await tempDir();
  const entry = join(directory, "oauth-setup.js");
  await writeFile(entry, "// the entry point\n");

  // An unresolvable path falls back to comparing the URLs: it does not
  // throw, and it is not the entry point.
  const missing = join(directory, "missing-oauth-setup.js");
  assert.equal(isMainModule(missing, entry), false);
  // No path at all is not the entry point either.
  assert.equal(isMainModule("", entry), false);
});

interface EntryResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the built setup entry point with the given environment. */
function runEntry(
  entry: string,
  env: NodeJS.ProcessEnv,
): Promise<EntryResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * The environment a spawned setup runs with: no account configuration, and a
 * client file that is not there.
 */
function entryEnv(directory: string): NodeJS.ProcessEnv {
  return cleanEnv({
    ZENDESK_OAUTH_CLIENT_FILE: join(directory, "missing-client.json"),
  });
}

test("runs the setup through a symlinked entry point", async () => {
  const directory = await tempDir();
  const entry = fileURLToPath(new URL("./oauth-setup.js", import.meta.url));
  const link = join(directory, "linked-oauth-setup.js");
  await symlink(entry, link);

  const result = await runEntry(link, entryEnv(directory));

  // The guard fires through the symlinked spelling: the run reports the
  // missing values instead of exiting silently.
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Zendesk OAuth setup needs/);
  assert.deepEqual(result.stdout, "");
});

test("runs the setup through the real entry point", async () => {
  const directory = await tempDir();
  const entry = fileURLToPath(new URL("./oauth-setup.js", import.meta.url));

  const result = await runEntry(entry, entryEnv(directory));

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Zendesk OAuth setup needs/);
  assert.deepEqual(result.stdout, "");
});
