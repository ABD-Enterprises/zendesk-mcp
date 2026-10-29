import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline/promises";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { redact } from "./audit.js";
import {
  CALLBACK_PORT_ERROR,
  INVALID_MODE_MESSAGE,
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
/** The most of a redacted body the error message echoes, in code points. */
const MAX_ECHO_CHARACTERS = 512;
/** The longest media type the error message echoes. */
const MAX_MEDIA_TYPE = 40;
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
/** The message printed when the account answer was empty. */
const ACCOUNT_CANCELLED_MESSAGE =
  "Setup cancelled: no Zendesk subdomain was entered.";
/** The message printed when the client id answer was empty. */
const CLIENT_ID_CANCELLED_MESSAGE =
  "Setup cancelled: no OAuth client id was entered.";
/** The message printed when the client secret answer was empty. */
const CLIENT_SECRET_CANCELLED_MESSAGE =
  "Setup cancelled: no OAuth client secret was entered.";
/** The message printed when the prompt closed before the setup finished. */
const PROMPT_CLOSED_MESSAGE =
  "Setup cancelled: the prompt was closed before the setup finished.";
/**
 * The message printed when a mode other than authorization_code was asked
 * for. The setup only runs the browser flow, so any other mode is refused.
 */
const MODE_ONLY_MESSAGE =
  "oauth:setup is only for authorization_code mode. Remove ZENDESK_OAUTH_MODE or set it to authorization_code.";
/**
 * The message printed when an access token is configured without a mode.
 * The setup writes a token file the configuration would never read.
 */
const ACCESS_TOKEN_ONLY_MESSAGE =
  "oauth:setup is only for authorization_code mode. Remove ZENDESK_OAUTH_ACCESS_TOKEN to run setup.";
/**
 * The message printed when the account answer is neither a subdomain nor a
 * URL. It names no environment variable, because the reader is answering a
 * prompt rather than setting one, and it does not repeat the answer.
 */
const INVALID_ACCOUNT_MESSAGE =
  "Not a valid Zendesk subdomain or URL (for example acme-tools or https://acme-tools.zendesk.com).";
/**
 * The message printed when the save answer is neither yes nor no. Like the
 * account refusal it names no environment variable and does not repeat the
 * answer; it tells the reader which answers the question takes.
 */
const INVALID_SAVE_ANSWER_MESSAGE = "Please answer y or n.";

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
 * the doctor hint — never a stack trace. A cancellation prints only its own
 * line: it is not a configuration problem.
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
  // A cancellation is not a configuration problem, so it carries the one
  // message line and no doctor hint.
  const cancel = (message: string): number => {
    writeError(`${message}\n`);
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
    return fail(INVALID_MODE_MESSAGE);
  }
  // Only the browser flow belongs to the setup, so every other mode is
  // refused before anything is asked.
  if (requestedMode !== undefined && requestedMode !== "authorization_code") {
    return fail(MODE_ONLY_MESSAGE);
  }
  // Without a requested mode an access token decides the mode, and it wins
  // over the client credentials: the setup would write a token file the
  // configuration never reads.
  if (requestedMode === undefined && env("ZENDESK_OAUTH_ACCESS_TOKEN")) {
    return fail(ACCESS_TOKEN_ONLY_MESSAGE);
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
      if (account === undefined) return cancel(ACCOUNT_CANCELLED_MESSAGE);
      // A full URL is stored under "baseUrl" and a bare subdomain under
      // "subdomain": the operations console builds the URL from "subdomain"
      // itself, so a URL in that field would be doubled. The URL is stored
      // as its origin, so a trailing slash or a path cannot break a
      // consumer that uses the field verbatim.
      if (isBaseUrl(account)) entered.baseUrl = account;
      else entered.subdomain = account;
    }
    if (missing.clientId) {
      const clientId = await ask(CLIENT_ID_QUESTION);
      if (!clientId) return cancel(CLIENT_ID_CANCELLED_MESSAGE);
      entered.clientId = clientId;
    }
    if (missing.clientSecret) {
      const clientSecret = await ask(CLIENT_SECRET_QUESTION, { mask: true });
      if (!clientSecret) return cancel(CLIENT_SECRET_CANCELLED_MESSAGE);
      entered.clientSecret = clientSecret;
    }

    const save = await askToSave(ask, writeError, clientFile);
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
    if (isPromptAbort(error)) return cancel(PROMPT_CLOSED_MESSAGE);
    return fail(errorMessage(error));
  } finally {
    prompter?.close();
  }
}

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
 *
 * A URL answer is returned as its origin, so the value that is stored is
 * the one every consumer expects: a trailing slash or a path would break a
 * consumer that uses the stored URL verbatim. A bare subdomain is returned
 * unchanged.
 */
async function askForAccount(
  ask: (question: string, options?: { mask?: boolean }) => Promise<string>,
  writeError: (line: string) => void,
): Promise<string | undefined> {
  for (;;) {
    const answer = await ask(ACCOUNT_QUESTION);
    if (!answer) return undefined;
    try {
      // The answer is validated the way it will be stored, so a URL is
      // checked as a URL and a bare name as a subdomain.
      if (isBaseUrl(answer)) {
        return resolveBaseUrl({ baseUrl: answer }) ?? answer;
      }
      resolveBaseUrl({ subdomain: answer });
      return answer;
    } catch {
      // The answer is unusable, so it is reported and asked again. The
      // message names no environment variable and does not repeat the answer.
      writeError(`${INVALID_ACCOUNT_MESSAGE}\n`);
    }
  }
}

/** True when the account answer is a full URL rather than a bare name. */
function isBaseUrl(answer: string): boolean {
  // A scheme is case-insensitive: HTTPS://… is a URL, not a subdomain.
  return /^https?:\/\//i.test(answer);
}

/**
 * Asks whether the entered values should be stored, asking again until the
 * answer is one this run understands. An answer that is neither yes nor no
 * is reported between the attempts.
 */
async function askToSave(
  ask: (question: string, options?: { mask?: boolean }) => Promise<string>,
  writeError: (line: string) => void,
  clientFile: string,
): Promise<boolean> {
  const question = `Save these values to ${clientFile} for future runs? [Y/n] `;
  for (;;) {
    const answer = (await ask(question)).trim().toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    // The question repeats with the same wording, so without this line an
    // answer the run cannot use would look like it was silently dropped.
    writeError(`${INVALID_SAVE_ANSWER_MESSAGE}\n`);
  }
}

/**
 * Reports the missing values and how to supply each of them.
 *
 * Every list is spelled the same way — "a", "a and b" or "a, b and c" — so
 * the sentence reads as one list rather than as spliced fragments.
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
    // Either variable names the account: one carries a subdomain, the other a
    // full URL. The alternative sits in parentheses so it reads as a choice
    // for this variable alone.
    variables.push("ZENDESK_SUBDOMAIN (or ZENDESK_BASE_URL)");
    // The file takes either field for the same reason; the field hint says
    // so in the same shape, or a reader would put in only half the choice.
    fields.push('"subdomain" (or "baseUrl")');
  }
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
  return `Zendesk OAuth setup needs ${formatList(needs)}. Set ${formatList(
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
 * The loopback port the callback server must bind for a redirect URI: the
 * port the URI names, or the scheme's default when it names none. The URL
 * parser normalizes a default port away — `new URL("http://127.0.0.1:80/…")`
 * reads back an empty `.port`, and `Number("")` is `0`, which would bind an
 * ephemeral port while the browser, the `redirect_uri`, and the printed URL
 * all still say `:80`. Binding the port the URI names keeps the listener on
 * the port the browser is sent to.
 */
export function callbackServerPort(redirectUri: string): number {
  const url = new URL(redirectUri);
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/**
 * The real authorization: a loopback callback server, the browser, and the
 * token exchange. Exported so a test can pin the port the listener binds;
 * the browser launcher is a parameter so such a test can also prove that
 * nothing is opened, and the wait deadline is a parameter so a test can
 * bound a failure path instead of sitting out the production timeout.
 */
export async function authorizeWithBrowser(
  config: ZendeskConfig,
  redirectUri: string,
  writeOut: (line: string) => void,
  spawnImpl?: BrowserSpawn,
  timeoutMs?: number,
): Promise<StoredToken> {
  const port = callbackServerPort(redirectUri);
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
    spawnImpl,
    timeoutMs,
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
  /**
   * Starts the browser. A test replaces it, so a test of the callback
   * server never launches one; the default is the real launcher.
   */
  spawnImpl?: BrowserSpawn;
  /**
   * How long to wait for the callback, in milliseconds. The default is the
   * production five-minute wait; a test bounds it so a failure path ends
   * promptly instead of lingering out the full timeout.
   */
  timeoutMs?: number;
}

/**
 * Waits for the browser to call back with an authorization code and returns
 * that code. A callback without a valid code or with the wrong state fails
 * the run.
 */
function waitForAuthorizationCode(
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
    }, options.timeoutMs ?? TIMEOUT_MS);

    function finish(error?: Error, code?: string) {
      clearTimeout(timeout);
      server.close();
      if (error) reject(error);
      else resolve(code!);
    }

    server.on("error", (error) => finish(error));
    server.listen(port, "127.0.0.1", () => {
      // The listener has to be on the port the redirect URI names, or the
      // browser is sent to a port nothing serves and the run sits out its
      // five-minute timeout. A bound port that disagrees is a bug, not a
      // wait condition: fail it here, before anything is printed or opened.
      const address = server.address();
      const bound = typeof address === "object" && address !== null ? address.port : -1;
      if (bound !== port) {
        finish(
          new Error(
            `Callback server bound port ${bound} instead of the port in the redirect URI (${port}).`,
          ),
        );
        return;
      }
      options.writeOut(`Opening Zendesk authorization:\n${options.authorizeUrl}\n`);
      openBrowser(options.authorizeUrl, options.writeOut, options.spawnImpl);
    });
  });
}

/** Exchanges an authorization code for the token the connector stores. */
async function exchangeCode(
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
    // A rejected body can still carry a real token: a 200 that fails the
    // shape check (a missing refresh_token, say) would otherwise print the
    // access token into the thrown error, which a caller may log or show.
    // The audit sink's redact() is the house filter, so it strips the keys
    // the filter knows — token, secret, password, authorization, cookie —
    // and the message keeps the rest of the response's diagnosable shape.
    // The filter matches key names, so it cannot see a token a middlebox
    // parked in the value of some innocuous key, nor one used as a key
    // itself — neither filter inspects what a name contains; that limit
    // belongs to the filters and is shared with every audit line, so the
    // call site keeps their contract rather than growing a second
    // redactor. Two keys they deliberately leave alone are dropped here
    // instead: a field named code in this body is the one-time
    // authorization code, and its client_id is the identifier that pairs
    // with it. The shared regex may not match either name — audit.test.ts
    // pins a code of 401 — so the strip lives at the call site, and the
    // status line and the remaining fields carry the diagnosis.
    //
    // A body that never parsed into a JSON object (a proxy's HTML error
    // page, say) has no keys at all to filter, so it is described by its
    // media type and size instead of echoed: a page that echoed the
    // request would carry the client secret and the one-time code. A
    // top-level array reaches the same note even though it did parse and
    // its entries do carry filterable keys: the shape check rejects an
    // array either way, and an array of unkeyed values is what the filter
    // cannot see into, so the guard below is deliberate rather than an
    // oversight. The media type is narrowed to a short, plain type/subtype
    // first — a header is free text, so nothing stops a middlebox from
    // stuffing a token-shaped subtype into one; the length bound below
    // keeps that echo small, and it is a bound on the echo, not a filter
    // on the header.
    const mediaType = response.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .toLowerCase();
    const described =
      mediaType !== undefined &&
      mediaType.length <= MAX_MEDIA_TYPE &&
      /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mediaType)
        ? ` ${mediaType}`
        : "";
    // The size is the utf-8 length of the decoded text, which is what the
    // message has in hand; a count of the raw wire bytes is not.
    const size = Buffer.byteLength(text, "utf8");
    const count = `${size} ${size === 1 ? "byte" : "bytes"}`;
    const objectShaped =
      payload !== null && typeof payload === "object" && !Array.isArray(payload);
    // Both filters recurse, and they run before the single JSON.stringify
    // this message used to do — so a body nested past the call stack's
    // depth overflows here where the old code did not. Nothing leaks: the
    // throw below still fires, and its note names the body as unprintable
    // rather than echoing any of it. A body that parsed from JSON can
    // never be circular, so depth is the only thing this catch sees.
    let echo: string | undefined;
    if (objectShaped) {
      try {
        echo = JSON.stringify(dropExchangeEcho(redact(payload)));
      } catch {
        echo = undefined;
      }
    }
    // The echo is bounded too: a multi-megabyte body would otherwise be
    // embedded whole, and past the bound the size says everything the
    // reader needs. The cut counts code points, not UTF-16 units — the
    // string iterator yields whole code points, so it cannot land between
    // the halves of a surrogate pair and leave a lone one behind — it
    // stops one point past the bound to learn whether a cut is needed at
    // all, and it runs after both filters, so a cut cannot resurrect what
    // they removed. The cut itself holds at most the bound's points; the
    // echo string above is materialized whole, so what the cut bounds is
    // the message, not the memory a large body costs on the way there.
    const points: string[] = [];
    let truncated = false;
    if (echo !== undefined) {
      for (const point of echo) {
        points.push(point);
        if (points.length > MAX_ECHO_CHARACTERS) {
          truncated = true;
          break;
        }
      }
    }
    const shown =
      echo === undefined
        ? objectShaped
          ? `(unprintable object body of ${count})`
          : text
            ? `(non-object${described} body of ${count})`
            : "(empty body)"
        : truncated
          ? `${points.slice(0, MAX_ECHO_CHARACTERS).join("")}… (body of ${count})`
          : echo;
    throw new Error(
      `Zendesk token exchange failed: HTTP ${response.status} ${shown}`,
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

/**
 * The part of a child process the browser launcher uses: it reports a failed
 * start and lets the parent walk away from it.
 */
export interface BrowserChild {
  /** Reports that the browser could not be started. */
  on(event: "error", listener: (error: Error) => void): void;
  /** Lets the parent process exit without waiting for the browser. */
  unref(): void;
}

/** Starts the browser. A test replaces it, so no browser is ever launched. */
export type BrowserSpawn = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: "ignore" },
) => BrowserChild;

/**
 * Opens the authorization URL in the user's browser.
 *
 * The default writes the line as it is, because the message carries its own
 * newline: a browser that could not be opened must not glue its line to the
 * next one.
 */
export function openBrowser(
  url: string,
  writeOut: (line: string) => void = (line) => {
    process.stdout.write(line);
  },
  spawnImpl: BrowserSpawn = spawn,
): void {
  const command =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawnImpl(command[0] as string, command[1] as string[], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {
    writeOut(
      "Could not open a browser automatically. Open the URL above manually.\n",
    );
  });
  child.unref();
}

/** Parses JSON, and falls back to the raw text when it is not JSON. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Drops the two fields the exchange request itself carries — code and
 * client_id — from a rejected body before it is echoed. A field named code
 * here is the one-time authorization code, and the shared audit filter may
 * not match that name — audit.test.ts pins a code of 401 — so the strip
 * lives at this call site rather than in the filter.
 */
function dropExchangeEcho(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropExchangeEcho);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/^(code|client_id)$/i.test(key))
      .map(([key, child]) => [key, dropExchangeEcho(child)]),
  );
}

/** True when a token response carries both tokens the connector stores. */
function isTokenResponse(
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
    const body = `${JSON.stringify(merged, null, 2)}\n`;
    try {
      await writeTemporaryFile(temporary, body);
      await rename(temporary, clientFile);
      await chmod(clientFile, 0o600);
    } catch (error) {
      // A failed write must not leave the temporary file behind: it holds the
      // client secret.
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return clientFile;
  };
}

/**
 * Writes the temporary file, refusing to write through a name that is
 * already taken.
 *
 * The name is predictable, so a link may already sit there. The write uses
 * the exclusive flag, so it fails instead of following the link; the stale
 * entry is removed and the write is retried once. The directory is
 * owner-only, so the entry can only be a stale temporary file or a link.
 */
async function writeTemporaryFile(
  temporary: string,
  body: string,
): Promise<void> {
  try {
    await writeFile(temporary, body, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    await rm(temporary, { force: true });
    await writeFile(temporary, body, { mode: 0o600, flag: "wx" });
  }
}

/** True when a failed write found the name already taken. */
function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "EEXIST"
  );
}

/** Asks a question on the terminal; the secret is not echoed. */
export interface Prompter {
  /** Asks one question and returns the answer. */
  ask: (question: string, options?: { mask?: boolean }) => Promise<string>;
  /** Releases the terminal. A pending answer fails with an abort error. */
  close: () => void;
}

/** The streams a prompter reads the answers from and writes the questions to. */
export interface PrompterStreams {
  /** The stream the answers arrive on. Defaults to `process.stdin`. */
  input?: NodeJS.ReadableStream;
  /** The stream the questions are written to. Defaults to `process.stdout`. */
  output?: NodeJS.WritableStream;
  /**
   * Whether the input behaves like a terminal. Left unset, readline decides
   * from the output, the way it does on its own.
   */
  terminal?: boolean;
  /**
   * How many answers readline keeps so the reader can recall them. Zero keeps
   * none, so a typed secret cannot be recalled and printed.
   */
  historySize?: number;
}

/**
 * The default prompter: one readline interface for the whole run, and a
 * muted output while a secret is typed.
 */
export function createReadlinePrompter(streams: PrompterStreams = {}): Prompter {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  let rl: Interface | undefined;
  let closed = false;
  let cancelPending: ((error: Error) => void) | undefined;

  const ensure = (): Interface => {
    if (!rl) {
      rl = createInterface({
        input,
        output,
        terminal: streams.terminal,
        // No history: a typed secret must not be recalled into the output.
        historySize: streams.historySize ?? 0,
      });
      // Readline closes the interface itself when the terminal sends Ctrl+C
      // or Ctrl+D. The Node versions that reject the pending question settle
      // the wait below on their own; the versions that do not would leave it
      // pending forever, so the close settles it here.
      rl.on("close", () => {
        closed = true;
        cancelPending?.(promptClosedError());
      });
    }
    return rl;
  };

  /** Asks readline one question that a `close` call can cancel. */
  const askLine = async (question: string): Promise<string> => {
    const line = ensure();
    const asked = line.question(question);
    // The race below reports the failure, so the question's own rejection is
    // already handled and cannot escape as an unhandled rejection.
    asked.catch(() => {});
    let cancel: ((error: Error) => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = reject;
    });
    cancelPending = cancel;
    try {
      return await Promise.race([asked, cancelled]);
    } finally {
      cancelPending = undefined;
    }
  };

  return {
    async ask(question: string, options?: { mask?: boolean }): Promise<string> {
      if (closed) throw promptClosedError();
      if (!options?.mask) {
        return (await askLine(question)).trim();
      }
      // The question is written before the output is muted, so the reader
      // sees what is asked but not what is typed.
      output.write(question);
      const restore = muteOutput(output);
      try {
        // The secret is kept exactly as it was typed: a secret may begin or
        // end with a space, and only an empty answer counts as nothing.
        return await askLine("");
      } finally {
        restore();
        output.write("\n");
      }
    },
    close(): void {
      closed = true;
      cancelPending?.(promptClosedError());
      rl?.close();
      rl = undefined;
    },
  };
}

/**
 * Stops the output from receiving anything while a secret is typed, and
 * returns a function that puts it back.
 */
function muteOutput(output: NodeJS.WritableStream): () => void {
  const target = output as unknown as { write: (chunk: string) => boolean };
  const original = target.write;
  const hadOwn = Object.prototype.hasOwnProperty.call(target, "write");
  target.write = () => true;
  return () => {
    if (hadOwn) {
      target.write = original;
      return;
    }
    delete (target as { write?: unknown }).write;
  };
}

/** The error a closed prompt reports; it reads like an aborted prompt. */
function promptClosedError(): Error {
  const error = new Error("The prompt was closed before the setup finished.");
  (error as Error & { code?: string }).code = "ABORT_ERR";
  return error;
}

/** True when a value names one of the supported OAuth modes. */
function isKnownMode(value: string): value is OAuthMode {
  return (OAUTH_MODES as readonly string[]).includes(value);
}

/** The message of a failure, without a stack trace. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * True when this module is the program the process was started with.
 *
 * The path as it was invoked is compared with the path of the loaded
 * module, and both are resolved to their real path first: a symlinked
 * entry file, or a path spelled differently from the real one, names the
 * same file and must still run the setup. A path that cannot be resolved
 * falls back to comparing the two URLs, so an unresolvable path reports
 * "not the entry point" instead of throwing.
 */
export function isMainModule(
  argvPath: string | undefined = process.argv[1],
  modulePath: string = fileURLToPath(import.meta.url),
): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(modulePath);
  } catch {
    return pathToFileURL(argvPath).href === pathToFileURL(modulePath).href;
  }
}

if (isMainModule()) {
  process.exitCode = await runOAuthSetup();
}
