import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const EXPIRY_SKEW_MS = 60_000;
const ACCESS_TOKEN_TTL_SECONDS = 3_600;
const REFRESH_TOKEN_TTL_SECONDS = 2_592_000;
const DEFAULT_SCOPE =
  "tickets:read tickets:write users:read organizations:read";

export type OAuthMode =
  | "authorization_code"
  | "client_credentials"
  | "access_token";

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

export function getConfig(): ZendeskConfig {
  const clientFile = env("ZENDESK_OAUTH_CLIENT_FILE") ?? defaultOAuthClientFile();
  const saved = readOAuthClientFile(clientFile);
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
      throw new ZendeskAuthError(
        "ZENDESK_OAUTH_MODE must be authorization_code, client_credentials, or access_token.",
      );
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

function readOAuthClientFile(clientFile: string): OAuthClientFile {
  try {
    const stats = statSync(clientFile);
    if (!stats.isFile()) {
      throw new ZendeskAuthError(
        `OAuth client configuration ${clientFile} is not a regular file.`,
      );
    }
    if ((stats.mode & 0o077) !== 0) {
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
  return ["authorization_code", "client_credentials", "access_token"].includes(
    value,
  );
}

export class ZendeskOAuth {
  private token?: StoredToken;
  private refreshInFlight?: Promise<StoredToken>;

  constructor(
    readonly config: ZendeskConfig = getConfig(),
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {}

  async getAccessToken(forceRefresh = false): Promise<string> {
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
        payload,
      );
    }

    const received = payload as TokenResponse;
    if (!received?.access_token) {
      throw new ZendeskAuthError(
        "Zendesk OAuth response did not include an access token.",
        response.status,
        payload,
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

function env(name: string): string | undefined {
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
