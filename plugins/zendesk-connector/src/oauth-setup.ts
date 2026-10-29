import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CALLBACK_PORT_ERROR,
  OAUTH_MODES,
  buildConfig,
  env,
  getConfig,
  isValidCallbackPort,
  oauthClientFilePath,
  readOAuthClientFile,
  resolveBaseUrl,
  resolveCallbackPort,
  writeTokenFile,
  type OAuthClientFile,
  type OAuthMode,
  type StoredToken,
  type ZendeskConfig,
} from "./auth.js";

const CALLBACK_PATH = "/callback";
const TIMEOUT_MS = 5 * 60 * 1000;
/** The hint every failure line carries, so the reader knows where to look. */
const DOCTOR_HINT = "Run npm run doctor to check the configuration.";
/** The prompt that asks for the account, with the two accepted spellings. */
const ACCOUNT_QUESTION =
  "Zendesk subdomain (for example acme-tools), or the full https://<subdomain>.zendesk.com URL: ";
/** The prompt that asks for the OAuth client id. */
const CLIENT_ID_QUESTION =
  "OAuth client id (Zendesk Admin Center > Apps and integrations > APIs > OAuth clients): ";
/** The prompt that asks for the OAuth client secret. */
const CLIENT_SECRET_QUESTION = "OAuth client secret: ";

interface OAuthSetupTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
}

export interface OAuthSetupOptions {
  /**
   * Loads the OAuth configuration. Defaults to `getConfig`.
   */
  loadConfig?: () => ZendeskConfig;
  /**
   * Asks the user one question and returns the trimmed answer. Defaults to a
   * readline prompt; `mask: true` hides the typed characters.
   */
  prompt?: (question: string, options?: { mask?: boolean }) => Promise<string>;
  /**
   * Reports whether the process can ask the user anything. Defaults to a
   * check for a terminal on both stdin and stdout.
   */
  isInteractive?: () => boolean;
  /**
   * Stores the entered values in the OAuth client file and returns the path
   * it wrote. Defaults to an owner-only write that keeps the fields the
   * user did not enter.
   */
  saveClientFile?: (values: OAuthClientFile) => Promise<string>;
  /**
   * Runs the browser authorization and returns the stored token. Defaults to
   * the real flow: a loopback callback server, the browser, and the token
   * exchange.
   */
  authorize?: (config: ZendeskConfig, redirectUri: string) => Promise<StoredToken>;
  /** Writes a progress line to stdout. */
  writeOut?: (line: string) => void;
  /** Writes one failure line to stderr. */
  writeError?: (line: string) => void;
}

/** The values a setup run is missing, and where each of them may come from. */
interface MissingValues {
  /** The Zendesk account (subdomain or base URL) is missing. */
  account: boolean;
  /** The OAuth client id is missing. */
  clientId: boolean;
  /** The OAuth client secret is missing. */
  clientSecret: boolean;
}

/**
 * Runs the one-time OAuth setup and returns the exit code for the process.
 *
 * A configured account runs the browser flow unchanged. A missing value is
 * asked for interactively; without a terminal the run reports what is
 * missing and how to supply it. Every failure prints one actionable line and
 * the doctor hint — never a stack trace.
 */
export async function runOAuthSetup(
  options: OAuthSetupOptions = {},
): Promise<number> {
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
  const fail = (message: string): number => {
    writeError(`${message}\n`);
    writeError(`${DOCTOR_HINT}\n`);
    return 1;
  };

  const port = resolveCallbackPort();
  if (!isValidCallbackPort(port)) {
    return fail(CALLBACK_PORT_ERROR);
  }

  const clientFile = oauthClientFilePath();
  let saved: OAuthClientFile = {};
  // A client file that is not there yet is nothing to repair: the run may
  // create it. A file that is there but unusable is reported instead.
  if (existsSync(clientFile)) {
    try {
      saved = readOAuthClientFile(clientFile);
    } catch (error) {
      // A broken client file is not something to prompt over: its own message
      // names what to repair.
      return fail(errorMessage(error));
    }
  }

  const requestedMode = env("ZENDESK_OAUTH_MODE") ?? saved.mode;
  if (requestedMode !== undefined && !isKnownMode(requestedMode)) {
    return fail(
      "ZENDESK_OAUTH_MODE must be authorization_code, client_credentials, or access_token.",
    );
  }
  if (requestedMode === "client_credentials") {
    return fail(
      "oauth:setup is only for authorization_code mode. Remove ZENDESK_OAUTH_MODE or set it to authorization_code.",
    );
  }

  // The environment wins over the client file, the same precedence
  // `buildConfig` applies.
  const missing: MissingValues = {
    account:
      !(
        env("ZENDESK_BASE_URL") ??
        env("ZENDESK_SUBDOMAIN") ??
        saved.baseUrl ??
        saved.subdomain
      ),
    clientId: !(env("ZENDESK_OAUTH_CLIENT_ID") ?? saved.clientId),
    clientSecret: !(env("ZENDESK_OAUTH_CLIENT_SECRET") ?? saved.clientSecret),
  };

  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const authorize =
    options.authorize ??
    ((config: ZendeskConfig, uri: string) =>
      authorizeWithBrowser(config, uri, writeOut));

  if (!missing.account && !missing.clientId && !missing.clientSecret) {
    let config: ZendeskConfig;
    try {
      config = (options.loadConfig ?? getConfig)();
    } catch (error) {
      return fail(errorMessage(error));
    }
    return finish(config, redirectUri, authorize, writeOut, fail);
  }

  const isInteractive =
    options.isInteractive ??
    (() => Boolean(process.stdin.isTTY && process.stdout.isTTY));
  if (!isInteractive()) {
    return fail(missingValuesMessage(missing, clientFile));
  }

  const prompter = options.prompt ? undefined : createReadlinePrompter();
  const ask = options.prompt ?? prompter!.ask;
  try {
    const entered: OAuthClientFile = {};

    if (missing.account) {
      const account = await askForAccount(ask, writeError);
      if (account === undefined) return fail(CANCELLED_MESSAGE);
      // The answer is stored under "subdomain" even when it is a full URL:
      // `resolveBaseUrl` accepts both spellings.
      entered.subdomain = account;
    }
    if (missing.clientId) {
      const clientId = await ask(CLIENT_ID_QUESTION);
      if (!clientId) return fail(CANCELLED_MESSAGE);
      entered.clientId = clientId;
    }
    if (missing.clientSecret) {
      const clientSecret = await ask(CLIENT_SECRET_QUESTION, { mask: true });
      if (!clientSecret) return fail(CANCELLED_MESSAGE);
      entered.clientSecret = clientSecret;
    }

    const save = await askToSave(ask, clientFile);
    if (save) {
      const saveClientFile =
        options.saveClientFile ?? defaultSaveClientFile(saved, clientFile);
      try {
        const written = await saveClientFile(entered);
        writeOut(`Saved OAuth client configuration to ${written}.\n`);
      } catch (error) {
        return fail(errorMessage(error));
      }
    }

    let config: ZendeskConfig;
    try {
      config = buildConfig({ ...saved, ...entered });
    } catch (error) {
      return fail(errorMessage(error));
    }
    return finish(config, redirectUri, authorize, writeOut, fail);
  } catch (error) {
    // A prompt that fails — the user closed the terminal, for instance —
    // must not end the run with a stack trace.
    return fail(isPromptAbort(error) ? CANCELLED_MESSAGE : errorMessage(error));
  } finally {
    prompter?.close();
  }
}

/** The message a run that entered nothing prints. */
const CANCELLED_MESSAGE = "Setup cancelled: no values were entered.";

/** True when a prompt ended because the terminal closed (Ctrl+D). */
function isPromptAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ABORT_ERR"
  );
}

/**
 * Asks for the account and validates the answer, asking again while it is
 * not a usable subdomain or base URL.
 */
async function askForAccount(
  ask: (question: string, options?: { mask?: boolean }) => Promise<string>,
  writeError: (line: string) => void,
): Promise<string | undefined> {
  for (;;) {
    const answer = await ask(ACCOUNT_QUESTION);
    if (!answer) return undefined;
    try {
      resolveBaseUrl({ subdomain: answer });
      return answer;
    } catch (error) {
      // The answer is unusable, so it is reported and asked again.
      writeError(`${errorMessage(error)}\n`);
    }
  }
}

/**
 * Asks whether the entered values should be stored, asking again until the
 * answer is one this run understands.
 */
async function askToSave(
  ask: (question: string, options?: { mask?: boolean }) => Promise<string>,
  clientFile: string,
): Promise<boolean> {
  const question = `Save these values to ${clientFile} for future runs? [Y/n] `;
  for (;;) {
    const answer = (await ask(question)).trim().toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
  }
}

/**
 * Reports the missing values and how to supply each of them.
 */
function missingValuesMessage(
  missing: MissingValues,
  clientFile: string,
): string {
  const needs: string[] = [];
  const variables: string[] = [];
  const fields: string[] = [];
  if (missing.account) {
    needs.push("the Zendesk subdomain");
    variables.push("ZENDESK_SUBDOMAIN");
    fields.push('"subdomain"');
  }
  if (missing.clientId && missing.clientSecret) {
    needs.push("the OAuth client id and secret");
    variables.push("ZENDESK_OAUTH_CLIENT_ID", "ZENDESK_OAUTH_CLIENT_SECRET");
    fields.push('"clientId"', '"clientSecret"');
  } else {
    if (missing.clientId) {
      needs.push("the OAuth client id");
      variables.push("ZENDESK_OAUTH_CLIENT_ID");
      fields.push('"clientId"');
    }
    if (missing.clientSecret) {
      needs.push("the OAuth client secret");
      variables.push("ZENDESK_OAUTH_CLIENT_SECRET");
      fields.push('"clientSecret"');
    }
  }
  return `Zendesk OAuth setup needs ${needs.join(", ")}. Set ${formatList(
    variables,
  )}, or add ${formatList(fields)} to ${clientFile}.`;
}

/** Formats a list as "a", "a and b", or "a, b and c". */
function formatList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Runs the authorization and stores the token, reporting one clean line when
 * either step fails.
 */
async function finish(
  config: ZendeskConfig,
  redirectUri: string,
  authorize: (
    config: ZendeskConfig,
    redirectUri: string,
  ) => Promise<StoredToken>,
  writeOut: (line: string) => void,
  fail: (message: string) => number,
): Promise<number> {
  let token: StoredToken;
  try {
    token = await authorize(config, redirectUri);
  } catch (error) {
    return fail(errorMessage(error));
  }
  try {
    await writeTokenFile(config.tokenFile, token);
  } catch (error) {
    return fail(errorMessage(error));
  }
  writeOut(`Zendesk OAuth tokens saved to ${config.tokenFile}\n`);
  return 0;
}

/**
 * The real authorization: a loopback callback server, the browser, and the
 * token exchange.
 */
async function authorizeWithBrowser(
  config: ZendeskConfig,
  redirectUri: string,
  writeOut: (line: string) => void,
): Promise<StoredToken> {
  const port = Number(new URL(redirectUri).port);
  const state = randomBytes(24).toString("hex");
  const authorizeUrl = new URL("/oauth/authorizations/new", config.baseUrl);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("client_id", config.clientId ?? "");
  authorizeUrl.searchParams.set("scope", config.scope);
  authorizeUrl.searchParams.set("state", state);

  const code = await waitForAuthorizationCode({
    port,
    path: CALLBACK_PATH,
    expectedState: state,
    authorizeUrl: authorizeUrl.toString(),
    writeOut,
  });
  return exchangeCode(config, redirectUri, code);
}

/** The loopback callback server's settings. */
interface CallbackServerOptions {
  /** The loopback port to listen on. */
  port: number;
  /** The path the callback is served on. */
  path: string;
  /** The state the callback must carry. */
  expectedState: string;
  /** The authorization URL to open once the server listens. */
  authorizeUrl: string;
  /** Writes the authorization URL to stdout. */
  writeOut: (line: string) => void;
}

/**
 * Waits for the browser to call back with an authorization code and returns
 * that code. A callback without a valid code or with the wrong state fails
 * the run.
 */
export function waitForAuthorizationCode(
  options: CallbackServerOptions,
): Promise<string> {
  const { port, path, expectedState } = options;
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== path) {
        response.writeHead(404).end("Not found");
        return;
      }

      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (error || !code || url.searchParams.get("state") !== expectedState) {
        response.writeHead(400, { "Content-Type": "text/plain" });
        response.end("Zendesk authorization failed. Return to the terminal for details.");
        finish(new Error(error || "OAuth callback was missing a valid code or state."));
        return;
      }

      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("Zendesk authorization complete. You can close this window.");
      finish(undefined, code);
    });

    const timeout = setTimeout(() => {
      finish(new Error("Timed out waiting for Zendesk authorization."));
    }, TIMEOUT_MS);

    function finish(error?: Error, code?: string) {
      clearTimeout(timeout);
      server.close();
      if (error) reject(error);
      else resolve(code!);
    }

    server.on("error", (error) => finish(error));
    server.listen(port, "127.0.0.1", () => {
      options.writeOut(`Opening Zendesk authorization:\n${options.authorizeUrl}\n`);
      openBrowser(options.authorizeUrl, options.writeOut);
    });
  });
}

/** Exchanges an authorization code for the token the connector stores. */
export async function exchangeCode(
  config: ZendeskConfig,
  redirectUri: string,
  code: string,
): Promise<StoredToken> {
  const response = await fetch(`${config.baseUrl}/oauth/tokens`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: redirectUri,
      scope: config.scope,
      expires_in: 3600,
      refresh_token_expires_in: 2592000,
    }),
  });
  const text = await response.text();
  const payload = text ? safeJson(text) : undefined;
  if (!response.ok || !isTokenResponse(payload)) {
    throw new Error(
      `Zendesk token exchange failed: HTTP ${response.status} ${JSON.stringify(payload)}`,
    );
  }

  return {
    access_token: payload.access_token as string,
    refresh_token: payload.refresh_token as string | undefined,
    token_type: payload.token_type as string | undefined,
    scope: (payload.scope as string | undefined) ?? config.scope,
    expires_at:
      typeof payload.expires_in === "number"
        ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
        : undefined,
  };
}

/** Opens the authorization URL in the user's browser. */
export function openBrowser(
  url: string,
  writeOut: (line: string) => void = (line) => {
    console.log(line);
  },
): void {
  const command =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command[0] as string, command[1] as string[], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {
    writeOut(
      "Could not open a browser automatically. Open the URL above manually.",
    );
  });
  child.unref();
}

/** Parses JSON, and falls back to the raw text when it is not JSON. */
export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** True when a token response carries both tokens the connector stores. */
export function isTokenResponse(
  value: unknown,
): value is OAuthSetupTokenResponse {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as Record<string, unknown>).access_token === "string" &&
      typeof (value as Record<string, unknown>).refresh_token === "string",
  );
}

/**
 * The default client-file writer: it merges the entered values over the
 * fields the file already holds and writes the result with owner-only
 * permissions.
 */
function defaultSaveClientFile(
  saved: OAuthClientFile,
  clientFile: string,
): (values: OAuthClientFile) => Promise<string> {
  return async (values: OAuthClientFile) => {
    const merged: OAuthClientFile = { ...saved, ...values };
    await mkdir(dirname(clientFile), { recursive: true, mode: 0o700 });
    const temporary = `${clientFile}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, clientFile);
    await chmod(clientFile, 0o600);
    return clientFile;
  };
}

/** Asks a question on the terminal; the secret is not echoed. */
interface Prompter {
  /** Asks one question and returns the trimmed answer. */
  ask: (question: string, options?: { mask?: boolean }) => Promise<string>;
  /** Releases the terminal. */
  close: () => void;
}

/**
 * The default prompter: one readline interface for the whole run, and a
 * muted output while a secret is typed.
 */
function createReadlinePrompter(): Prompter {
  let rl: Interface | undefined;
  let output: { write(chunk: string): boolean } | undefined;
  const ensure = (): Interface => {
    if (!rl) {
      output = process.stdout as unknown as { write(chunk: string): boolean };
      rl = createInterface({ input: process.stdin, output: process.stdout });
    }
    return rl;
  };
  return {
    async ask(question: string, options?: { mask?: boolean }): Promise<string> {
      const line = ensure();
      if (!options?.mask) {
        return (await line.question(question)).trim();
      }
      // The question is written before the output is muted, so the reader
      // sees what is asked but not what is typed.
      const stream = output!;
      stream.write(question);
      const original = stream.write;
      stream.write = () => true;
      try {
        return (await line.question("")).trim();
      } finally {
        stream.write = original;
        stream.write("\n");
      }
    },
    close(): void {
      rl?.close();
      rl = undefined;
    },
  };
}

/** True when a value names one of the supported OAuth modes. */
function isKnownMode(value: string): value is OAuthMode {
  return (OAUTH_MODES as readonly string[]).includes(value);
}

/** The message of a failure, without a stack trace. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await runOAuthSetup();
}
