import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { OAuthClientFile, StoredToken, ZendeskConfig } from "./auth.js";
import { runOAuthSetup, type OAuthSetupOptions } from "./oauth-setup.js";

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
  const stats = await stat(files.tokenFile);
  assert.equal(stats.mode & 0o777, 0o600);
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
  const clientStats = await stat(files.clientFile);
  assert.equal(clientStats.mode & 0o777, 0o600);

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
    `Zendesk OAuth setup needs the Zendesk subdomain, the OAuth client id and secret. Set ZENDESK_SUBDOMAIN, ZENDESK_OAUTH_CLIENT_ID and ZENDESK_OAUTH_CLIENT_SECRET, or add "subdomain", "clientId" and "clientSecret" to ${files.clientFile}.\n`,
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

test("asks again when the account answer is not a subdomain", async () => {
  await sandbox();
  const result = await runSetup({
    answers: [
      "bad value!!!",
      "acme-tools",
      "example-client-id",
      "example-client-secret",
      "n",
    ],
  });

  assert.equal(result.code, 0);
  assert.equal(result.questions.length, 5);
  assert.match(result.questions[0], /^Zendesk subdomain/);
  assert.match(result.questions[1], /^Zendesk subdomain/);
  assert.match(result.err[0], /is not a valid subdomain/);
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
  assert.equal(result.err[0], "Setup cancelled: no values were entered.\n");
  assert.equal(
    result.err[1],
    "Run npm run doctor to check the configuration.\n",
  );
  assert.equal(await readFile(files.clientFile, "utf8"), "{}");
  await assert.rejects(() => readFile(files.tokenFile, "utf8"));
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
  assert.equal(err[0], "Setup cancelled: no values were entered.\n");
  assert.equal(
    err[1],
    "Run npm run doctor to check the configuration.\n",
  );
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

test("refuses a client file that other users can read", async () => {
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

test("stores a full account URL under the subdomain field", async () => {
  const files = await sandbox();
  const result = await runSetup({
    answers: [
      "https://acme-tools.zendesk.com",
      "example-client-id",
      "example-client-secret",
      "y",
    ],
  });

  assert.equal(result.code, 0);
  const client = JSON.parse(await readFile(files.clientFile, "utf8"));
  assert.equal(client.subdomain, "https://acme-tools.zendesk.com");
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
  const config: ZendeskConfig = {
    baseUrl: "https://acme-tools.zendesk.com",
    mode: "authorization_code",
    clientId: "example-client-id",
    clientSecret: "example-client-secret",
    tokenFile: files.tokenFile,
    scope: "tickets:read",
  };

  const result = await runSetup({ loadConfig: () => config });

  assert.equal(result.code, 0);
  assert.equal(result.authorizations.length, 1);
  assert.equal(
    result.authorizations[0].redirectUri,
    "http://127.0.0.1:3219/callback",
  );
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
