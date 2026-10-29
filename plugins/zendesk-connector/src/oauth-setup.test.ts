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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { OAuthClientFile, StoredToken, ZendeskConfig } from "./auth.js";
import {
  callbackServerPort,
  createReadlinePrompter,
  isMainModule,
  openBrowser,
  runOAuthSetup,
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
  const out: string[] = [];
  const err: string[] = [];
  const authorizations: { baseUrl: string; redirectUri: string }[] = [];

  const setupOptions: OAuthSetupOptions = {
    prompt: async (question) => {
      questions.push(question);
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

  return { code, out, err, questions, authorizations };
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
    `Zendesk OAuth setup needs the Zendesk subdomain, the OAuth client id and the OAuth client secret. Set ZENDESK_SUBDOMAIN (or ZENDESK_BASE_URL), ZENDESK_OAUTH_CLIENT_ID and ZENDESK_OAUTH_CLIENT_SECRET, or add "subdomain", "clientId" and "clientSecret" to ${files.clientFile}.\n`,
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
    `Zendesk OAuth setup needs the Zendesk subdomain and the OAuth client secret. Set ZENDESK_SUBDOMAIN (or ZENDESK_BASE_URL) and ZENDESK_OAUTH_CLIENT_SECRET, or add "subdomain" and "clientSecret" to ${files.clientFile}.\n`,
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
