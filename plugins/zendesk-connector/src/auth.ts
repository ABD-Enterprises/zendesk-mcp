import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const EXPIRY_SKEW_MS = 60_000;
const ACCESS_TOKEN_TTL_SECONDS = 3_600;
const REFRESH_TOKEN_TTL_SECONDS = 2_592_000;
const DEFAULT_SCOPE =
  "tickets:read tickets:write users:read organizations:read brands:read groups:read";

export type OAuthMode =
  | "authorization_code"
  | "client_credentials"
  | "access_token";

/** The OAuth modes `getConfig` can produce, in `OAuthMode` order. */
export const OAUTH_MODES: readonly OAuthMode[] = [
  "authorization_code",
  "client_credentials",
  "access_token",
];

export interface ZendeskConfig {
  baseUrl: string;
  mode: OAuthMode;
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  tokenFile: string;
  scope: string;
}

export interface OAuthClientFile {
  subdomain?: string;
  baseUrl?: string;
  mode?: OAuthMode;
  clientId?: string;
  clientSecret?: string;
  tokenFile?: string;
  scope?: string;
}

export interface StoredToken {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_at?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
}

export class ZendeskAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ZendeskAuthError";
  }
}

export function resolveBaseUrl(
  saved: Pick<OAuthClientFile, "baseUrl" | "subdomain"> = {},
): string | undefined {
  const explicit = env("ZENDESK_BASE_URL");
  const configuredBaseUrl = explicit ?? saved.baseUrl;
  if (configuredBaseUrl) {
    return validateBaseUrl(configuredBaseUrl.replace(/\/+$/, ""));
  }

  const subdomain = env("ZENDESK_SUBDOMAIN") ?? saved.subdomain;
  if (!subdomain) return undefined;
  if (subdomain.startsWith("http://") || subdomain.startsWith("https://")) {
    return validateBaseUrl(subdomain.replace(/\/+$/, ""));
  }
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(subdomain)) {
    throw new ZendeskAuthError("ZENDESK_SUBDOMAIN is not a valid subdomain.");
  }
  return `https://${subdomain}.zendesk.com`;
}

export function defaultTokenFile(): string {
  return join(homedir(), ".config", "codex-zendesk", "oauth.json");
}

export function defaultOAuthClientFile(): string {
  return join(homedir(), ".config", "codex-zendesk", "client.json");
}

/** The path of the owner-only OAuth client configuration file. */
export function oauthClientFilePath(): string {
  return env("ZENDESK_OAUTH_CLIENT_FILE") ?? defaultOAuthClientFile();
}

/**
 * True when two paths name the same file.
 *
 * Existing paths are compared by device and inode, so a case-variant or
 * symlinked spelling of the client file on a case-insensitive volume is still
 * the same file. An inode of 0 is not an identity (some FAT and network
 * filesystems report it for every file), and a path that cannot be stat'd
 * falls back to the resolved string — all that is left when one side does not
 * exist yet. A non-string path (only reachable through an unchecked config
 * value) is never a match; the caller's own read reports it.
 */
export function sameFilePath(first: string, second: string): boolean {
  if (typeof first !== "string" || typeof second !== "string") return false;
  try {
    const a = statSync(first);
    const b = statSync(second);
    if (a.ino !== 0 && b.ino !== 0) {
      return a.dev === b.dev && a.ino === b.ino;
    }
  } catch {
    // One side cannot be stat'd; compare the resolved strings below.
  }
  return resolve(first) === resolve(second);
}

/** The default loopback port the one-time browser setup listens on. */
const OAUTH_CALLBACK_PORT_DEFAULT = 3219;

/** The message both `oauth:setup` and the doctor report for an unusable port. */
export const CALLBACK_PORT_ERROR =
  "ZENDESK_OAUTH_CALLBACK_PORT must be an integer from 1 to 65535, written as decimal digits (for example 3219).";

/** True when a raw callback-port value is a usable TCP port. */
export function isValidCallbackPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Reads the setup callback port exactly as `oauth:setup` interprets it: the
 * environment value must be written as decimal digits (a trimmed run of
 * `0`–`9`), with no empty-value, `${...}` placeholder, or `0x10`-style
 * leniency — an unusable value must surface as an error in both the setup
 * and the doctor, not be silently defaulted or reinterpreted in one of them.
 */
export function resolveCallbackPort(): number {
  const raw = process.env.ZENDESK_OAUTH_CALLBACK_PORT;
  if (raw === undefined) return OAUTH_CALLBACK_PORT_DEFAULT;
  const digits = raw.trim();
  // Number() alone would read "0x10" as 16 and "1e3" as 1000, values no
  // caller wrote as a port; a non-decimal string becomes NaN, which the
  // shared isValidCallbackPort check rejects with CALLBACK_PORT_ERROR.
  return /^\d+$/.test(digits) ? Number(digits) : Number.NaN;
}

export function getConfig(): ZendeskConfig {
  const clientFile = oauthClientFilePath();
  const saved = readOAuthClientFile(clientFile);
  return buildConfig(saved);
}

/**
 * The message both `buildConfig` and `oauth:setup` report for a mode that
 * is not one of `OAUTH_MODES`. The two used to carry their own copies of
 * the sentence, which could drift apart.
 */
export const INVALID_MODE_MESSAGE =
  "ZENDESK_OAUTH_MODE must be authorization_code, client_credentials, or access_token.";

/**
 * Builds the connector's configuration from a saved client file.
 *
 * The environment still wins over the file (the same precedence `getConfig`
 * applies), so a caller that has already read the client file can build the
 * configuration without reading it again.
 */
export function buildConfig(saved: OAuthClientFile): ZendeskConfig {
  const baseUrl = resolveBaseUrl(saved);
  if (!baseUrl) {
    throw new ZendeskAuthError(
      "Zendesk connector is not configured. Set ZENDESK_SUBDOMAIN or ZENDESK_BASE_URL.",
    );
  }

  const requestedMode = env("ZENDESK_OAUTH_MODE") ?? saved.mode;
  const accessToken = env("ZENDESK_OAUTH_ACCESS_TOKEN");
  const clientId = env("ZENDESK_OAUTH_CLIENT_ID") ?? saved.clientId;
  const clientSecret = env("ZENDESK_OAUTH_CLIENT_SECRET") ?? saved.clientSecret;
  const tokenFile =
    env("ZENDESK_OAUTH_TOKEN_FILE") ?? saved.tokenFile ?? defaultTokenFile();
  const scope = env("ZENDESK_OAUTH_SCOPE") ?? saved.scope ?? DEFAULT_SCOPE;

  let mode: OAuthMode;
  if (requestedMode) {
    if (!isOAuthMode(requestedMode)) {
      throw new ZendeskAuthError(INVALID_MODE_MESSAGE);
    }
    mode = requestedMode;
  } else if (accessToken) {
    mode = "access_token";
  } else if (clientId && clientSecret) {
    mode = "authorization_code";
  } else {
    throw new ZendeskAuthError(
      "Zendesk OAuth is not configured. Set OAuth client credentials and run npm run oauth:setup, or select client_credentials mode.",
    );
  }

  if (mode === "access_token" && !accessToken) {
    throw new ZendeskAuthError(
      "ZENDESK_OAUTH_ACCESS_TOKEN is required for access_token mode.",
    );
  }
  if (mode !== "access_token" && (!clientId || !clientSecret)) {
    throw new ZendeskAuthError(
      "ZENDESK_OAUTH_CLIENT_ID and ZENDESK_OAUTH_CLIENT_SECRET are required for this OAuth mode.",
    );
  }

  return {
    baseUrl,
    mode,
    clientId,
    clientSecret,
    accessToken,
    tokenFile,
    scope,
  };
}

/**
 * Reads the OAuth client file and checks that it is safe to use: a regular
 * file, readable only by its owner, and a JSON object whose account fields
 * are strings.
 */
export function readOAuthClientFile(clientFile: string): OAuthClientFile {
  try {
    const stats = statSync(clientFile);
    if (!stats.isFile()) {
      throw new ZendeskAuthError(
        `OAuth client configuration ${clientFile} is not a regular file.`,
      );
    }
    // Node reports synthetic permission bits on Windows (group and other always
    // look set), so the check is skipped there instead of failing every run.
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
      throw new ZendeskAuthError(
        `OAuth client configuration ${clientFile} must be readable only by its owner (chmod 600).`,
      );
    }
    const payload = JSON.parse(readFileSync(clientFile, "utf8")) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ZendeskAuthError(
        `OAuth client configuration ${clientFile} must contain a JSON object.`,
      );
    }
    // The cast below promises strings, and the consumers treat them as such
    // (`resolveBaseUrl` trims them, fs calls throw a raw TypeError on a
    // number), so a JSON value of the wrong type is rejected here — as the
    // field is read, before any consumer can trip over it.
    const account = payload as { baseUrl?: unknown; subdomain?: unknown };
    for (const field of ["baseUrl", "subdomain"] as const) {
      const value = account[field];
      if (value !== undefined && typeof value !== "string") {
        throw new ZendeskAuthError(
          `OAuth client configuration ${clientFile} has a "${field}" value that must be a string.`,
        );
      }
    }
    // An empty tokenFile is equally unusable as a wrong-typed one: it is not
    // a path, and it does not fall back to the default.
    const saved = payload as { tokenFile?: unknown };
    if (
      saved.tokenFile !== undefined &&
      (typeof saved.tokenFile !== "string" || saved.tokenFile.trim() === "")
    ) {
      throw new ZendeskAuthError(
        `OAuth client configuration ${clientFile} has a "tokenFile" value that must be a non-empty path string.`,
      );
    }
    return payload as OAuthClientFile;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT" &&
      !env("ZENDESK_OAUTH_CLIENT_FILE")
    ) {
      return {};
    }
    if (error instanceof ZendeskAuthError) throw error;
    throw new ZendeskAuthError(
      `Unable to read OAuth client configuration ${clientFile}.`,
      undefined,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function isOAuthMode(value: string): value is OAuthMode {
  return (OAUTH_MODES as readonly string[]).includes(value);
}

export class ZendeskOAuth {
  private token?: StoredToken;
  private refreshInFlight?: Promise<StoredToken>;
  private loggedOut = false;

  constructor(
    readonly config: ZendeskConfig = getConfig(),
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {}

  async getAccessToken(forceRefresh = false): Promise<string> {
    if (this.loggedOut) {
      throw new ZendeskAuthError(
        "The Zendesk OAuth session was logged out; no further token requests are allowed.",
      );
    }

    if (this.config.mode === "access_token") {
      return this.config.accessToken!;
    }

    if (!this.token && this.config.mode === "authorization_code") {
      this.token = await this.readTokenFile();
    }

    if (!forceRefresh && this.token && !isExpiring(this.token)) {
      return this.token.access_token;
    }

    const token = await this.refresh();
    return token.access_token;
  }

  canRefresh(): boolean {
    return this.config.mode !== "access_token";
  }

  /**
   * Ends the OAuth session: the cached token is dropped and later token
   * requests fail with a clear error. A refresh that is still in flight is
   * awaited first, so it cannot write the token file back after the caller
   * removed it.
   */
  async clearToken(): Promise<void> {
    const inFlight = this.refreshInFlight;
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        // A failed refresh has nothing left to keep; the cache is dropped.
      }
    }
    this.token = undefined;
    this.refreshInFlight = undefined;
    this.loggedOut = true;
  }

  status() {
    return {
      mode: this.config.mode,
      scope: this.config.scope,
      tokenFile:
        this.config.mode === "authorization_code"
          ? this.config.tokenFile
          : undefined,
      refreshEnabled: this.canRefresh(),
      expiresAt: this.token?.expires_at,
    };
  }

  private async refresh(): Promise<StoredToken> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.requestNewToken().finally(() => {
        this.refreshInFlight = undefined;
      });
    }
    return this.refreshInFlight;
  }

  private async requestNewToken(): Promise<StoredToken> {
    const body: Record<string, unknown> = {
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      scope: this.config.scope,
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token_expires_in: REFRESH_TOKEN_TTL_SECONDS,
    };

    if (this.config.mode === "client_credentials") {
      body.grant_type = "client_credentials";
    } else {
      if (!this.token?.refresh_token) {
        throw new ZendeskAuthError(
          `No refresh token found in ${this.config.tokenFile}. Run npm run oauth:setup from the plugin directory.`,
        );
      }
      body.grant_type = "refresh_token";
      body.refresh_token = this.token.refresh_token;
    }

    const response = await this.fetcher(`${this.config.baseUrl}/oauth/tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const payload = text ? safeJson(text) : undefined;
    if (!response.ok) {
      throw new ZendeskAuthError(
        `Zendesk OAuth token request failed: HTTP ${response.status} ${response.statusText}`,
        response.status,
        summarizeTokenResponse(text, response.headers.get("content-type")),
      );
    }

    const received = payload as TokenResponse;
    if (!received?.access_token) {
      throw new ZendeskAuthError(
        "Zendesk OAuth response did not include an access token.",
        response.status,
        summarizeTokenResponse(text, response.headers.get("content-type")),
      );
    }

    const token: StoredToken = {
      access_token: received.access_token,
      refresh_token: received.refresh_token ?? this.token?.refresh_token,
      token_type: received.token_type,
      scope: received.scope ?? this.config.scope,
      expires_at:
        typeof received.expires_in === "number"
          ? new Date(Date.now() + received.expires_in * 1000).toISOString()
          : undefined,
    };
    this.token = token;

    if (this.config.mode === "authorization_code") {
      await writeTokenFile(this.config.tokenFile, token);
    }
    return token;
  }

  private async readTokenFile(): Promise<StoredToken> {
    let payload: unknown;
    try {
      payload = JSON.parse(await readFile(this.config.tokenFile, "utf8"));
    } catch (error) {
      throw new ZendeskAuthError(
        `Unable to read OAuth token file ${this.config.tokenFile}. Run npm run oauth:setup from the plugin directory.`,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }

    const token = payload as StoredToken;
    if (!token?.access_token) {
      throw new ZendeskAuthError(
        `OAuth token file ${this.config.tokenFile} does not contain an access_token.`,
      );
    }
    return token;
  }
}

/**
 * The API path that revokes the token the request is authenticated with. The
 * shared request plumbing prefixes it with `/api/v2` and the configured base
 * URL, so the request reaches `DELETE {base}/api/v2/oauth/tokens/current`.
 */
export const REVOKE_CURRENT_TOKEN_PATH = "/oauth/tokens/current";

/**
 * Issues an authenticated request against the Zendesk API. `ZendeskClient.request`
 * satisfies this shape, so a revocation reuses the retries, the headers and the
 * error mapping of every other API call.
 */
export type OAuthRequester = (
  path: string,
  options: { method: "GET" | "POST" | "PUT" | "DELETE" },
) => Promise<unknown>;

/** The outcome of a remote token revocation. */
export interface RevocationResult {
  /** True when Zendesk confirmed that the token was deleted. */
  revoked: boolean;
  /** The HTTP status Zendesk returned, undefined when no answer arrived. */
  status?: number;
  /** Why the revocation failed. Never carries credential material. */
  error?: string;
}

/**
 * Revokes the current OAuth token at Zendesk.
 *
 * The outcome is reported instead of thrown: a failed revocation must never
 * stop the caller from clearing the local credentials.
 */
export async function revokeCurrentToken(
  request: OAuthRequester,
): Promise<RevocationResult> {
  try {
    await request(REVOKE_CURRENT_TOKEN_PATH, { method: "DELETE" });
    return { revoked: true };
  } catch (error) {
    const status = errorStatus(error);
    return {
      revoked: false,
      ...(status === undefined ? {} : { status }),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Removes the persisted OAuth token file. A missing file is not an error:
 * there is nothing left to remove.
 */
export async function removeTokenFile(tokenFile: string): Promise<boolean> {
  try {
    await unlink(tokenFile);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

/**
 * Resolves the path of the persisted OAuth token file. Unlike `getConfig` this
 * never throws, so a logout can still clear the local credentials when the
 * configuration is incomplete.
 */
export function resolveTokenFile(): string {
  try {
    return getConfig().tokenFile;
  } catch {
    // The configuration is unusable, but the token file may still be named
    // by the environment or by the client file: a logout must remove the
    // file the connector actually wrote, not a default path that was never
    // used. The precedence matches getConfig's — environment, then client
    // file, then default — with each unreadable step skipped.
    return (
      env("ZENDESK_OAUTH_TOKEN_FILE") ?? savedTokenFile() ?? defaultTokenFile()
    );
  }
}

/** The client file's tokenFile field, read leniently. */
function savedTokenFile(): string | undefined {
  // The fallback needs only a path — not secret material, and not a
  // validated configuration — so the file's other checks (owner-only
  // permissions, the types of baseUrl/subdomain) are deliberately not
  // applied here: a client file that fails one of them must still lead
  // logout at the token file it names, not at a default path the connector
  // never wrote. The strict reader's one structural guard is kept, though:
  // reading a non-regular path (a FIFO, say) would block the fallback —
  // and the whole logout — forever. Anything unusable — a non-regular
  // path, a missing file, unparseable JSON, a wrong-typed or empty field —
  // falls through to the default.
  try {
    const clientFile = oauthClientFilePath();
    if (!statSync(clientFile).isFile()) {
      return undefined;
    }
    const payload = JSON.parse(readFileSync(clientFile, "utf8")) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return undefined;
    }
    const tokenFile = (payload as { tokenFile?: unknown }).tokenFile;
    return typeof tokenFile === "string" && tokenFile.trim() !== ""
      ? tokenFile
      : undefined;
  } catch {
    return undefined;
  }
}

export async function writeTokenFile(
  tokenFile: string,
  token: StoredToken,
): Promise<void> {
  const directory = dirname(tokenFile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${tokenFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(token, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, tokenFile);
  await chmod(tokenFile, 0o600);
}

function validateBaseUrl(value: string): string {
  const url = new URL(value);
  const isLocalhost =
    url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost)) {
    throw new ZendeskAuthError(
      "ZENDESK_BASE_URL must use HTTPS (HTTP is allowed only for localhost).",
    );
  }
  return url.origin;
}

/** Reads a trimmed env value; empty and literal `${...}` placeholders count as unset. */
export function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && !/^\$\{[^}]+\}$/.test(value) ? value : undefined;
}

function isExpiring(token: StoredToken): boolean {
  if (!token.expires_at) return false;
  const expiresAt = Date.parse(token.expires_at);
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now() + EXPIRY_SKEW_MS;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Describes a token endpoint response without carrying any of its values.
 *
 * The details of an auth error travel with the failure to the MCP client, so
 * a raw body would put a live access token, a refresh token, or a client
 * secret echoed back by the endpoint in front of the model. This summary
 * keeps what a human needs to diagnose the failure - the media type, the
 * size, the field names that came back and the OAuth error code - and drops
 * every value.
 */
function summarizeTokenResponse(
  text: string,
  contentType: string | null,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    mediaType: narrowMediaType(contentType),
    bytes: Buffer.byteLength(text, "utf8"),
  };
  const payload = text ? safeJson(text) : undefined;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    summary.keys = Object.keys(record).slice(0, 32).map(safeFieldName);
    // The OAuth error code is a fixed, lowercase vocabulary, so it is safe to
    // keep and it is what tells an agent why the exchange was refused.
    const code = record.error;
    if (typeof code === "string" && /^[a-z][a-z0-9_]{0,31}$/.test(code)) {
      summary.error = code;
    }
  }
  return summary;
}

/**
 * Keeps a JSON field name and masks anything that looks like an opaque
 * credential a server parked in the name position.
 */
function safeFieldName(name: string): string {
  return /^[a-z][a-z0-9_]{0,63}$/.test(name) && !/\d{3,}/.test(name)
    ? name
    : "[REDACTED]";
}

/** Narrows a Content-Type to its bare `type/subtype`, without parameters. */
function narrowMediaType(contentType: string | null): string {
  const bare = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(
    bare,
  )
    ? bare
    : "unknown";
}

/**
 * Reads the HTTP status of a failed request. The status is read structurally
 * because the API error type lives in the module that imports this one.
 */
function errorStatus(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
