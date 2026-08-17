import { ZendeskOAuth, getConfig, type ZendeskConfig } from "./auth.js";

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_RETRY_DELAY_MS = 10_000;

export interface ZendeskRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export class ZendeskError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ZendeskError";
  }
}

export class ZendeskClient {
  readonly auth: ZendeskOAuth;
  readonly config: ZendeskConfig;

  constructor(
    config: ZendeskConfig = getConfig(),
    private readonly fetcher: typeof fetch = globalThis.fetch,
    private readonly sleep: (milliseconds: number) => Promise<void> = delay,
    private readonly maxRetries = readIntegerEnv(
      "ZENDESK_MAX_RETRIES",
      DEFAULT_MAX_RETRIES,
      0,
      5,
    ),
    private readonly maxRetryDelayMs = readIntegerEnv(
      "ZENDESK_MAX_RETRY_DELAY_MS",
      DEFAULT_MAX_RETRY_DELAY_MS,
      0,
      60_000,
    ),
  ) {
    this.config = config;
    this.auth = new ZendeskOAuth(config, fetcher);
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  async request<T>(
    path: string,
    options: ZendeskRequestOptions = {},
  ): Promise<T> {
    const url = new URL(`/api/v2${path}`, this.config.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const serializedBody =
      options.body === undefined ? undefined : JSON.stringify(options.body);
    let refreshed = false;
    let retries = 0;

    while (true) {
      const response = await this.fetcher(url, {
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bearer ${await this.auth.getAccessToken(refreshed)}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "abd-enterprises-zendesk-mcp/0.3.0",
        },
        body: serializedBody,
      });

      if (response.status === 401 && this.auth.canRefresh() && !refreshed) {
        refreshed = true;
        continue;
      }

      if (response.status === 429 && retries < this.maxRetries) {
        const retryDelay = getRetryDelayMs(response);
        if (retryDelay <= this.maxRetryDelayMs) {
          retries += 1;
          await this.sleep(retryDelay);
          continue;
        }
      }

      const text = await response.text();
      const payload = text ? safeJson(text) : undefined;
      if (!response.ok) {
        throw new ZendeskError(
          `Zendesk API request failed: HTTP ${response.status} ${response.statusText}`,
          response.status,
          {
            response: payload ?? text,
            retryAfterSeconds: getRetryAfterSeconds(response),
            rateLimitRemaining:
              response.headers.get("ratelimit-remaining") ??
              response.headers.get("x-rate-limit-remaining"),
            rateLimitResetSeconds: response.headers.get("ratelimit-reset"),
          },
        );
      }

      return payload as T;
    }
  }
}

function getRetryDelayMs(response: Response): number {
  return Math.max(0, Math.ceil(getRetryAfterSeconds(response) * 1000));
}

function getRetryAfterSeconds(response: Response): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds);

    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, (date - Date.now()) / 1000);
  }

  const reset = Number(response.headers.get("ratelimit-reset"));
  return Number.isFinite(reset) ? Math.max(0, reset) : 1;
}

function readIntegerEnv(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
