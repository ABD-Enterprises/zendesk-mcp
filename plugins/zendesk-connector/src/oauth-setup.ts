import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { getConfig, writeTokenFile } from "./auth.js";

const CALLBACK_PORT = Number(process.env.ZENDESK_OAUTH_CALLBACK_PORT ?? 3219);
const CALLBACK_PATH = "/callback";
const TIMEOUT_MS = 5 * 60 * 1000;

interface OAuthSetupTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
}

if (!Number.isInteger(CALLBACK_PORT) || CALLBACK_PORT < 1 || CALLBACK_PORT > 65535) {
  throw new Error("ZENDESK_OAUTH_CALLBACK_PORT must be an integer from 1 to 65535.");
}

const config = getConfig();
if (!config.clientId || !config.clientSecret) {
  throw new Error("OAuth client credentials are required for setup.");
}
if (config.mode === "client_credentials") {
  throw new Error(
    "oauth:setup is only for authorization_code mode. Remove ZENDESK_OAUTH_MODE or set it to authorization_code.",
  );
}

const redirectUri = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;
const state = randomBytes(24).toString("hex");
const authorizeUrl = new URL("/oauth/authorizations/new", config.baseUrl);
authorizeUrl.searchParams.set("response_type", "code");
authorizeUrl.searchParams.set("redirect_uri", redirectUri);
authorizeUrl.searchParams.set("client_id", config.clientId);
authorizeUrl.searchParams.set("scope", config.scope);
authorizeUrl.searchParams.set("state", state);

const code = await waitForAuthorizationCode(state);
const token = await exchangeCode(code);
await writeTokenFile(config.tokenFile, token);
console.log(`Zendesk OAuth tokens saved to ${config.tokenFile}`);

function waitForAuthorizationCode(expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", redirectUri);
      if (url.pathname !== CALLBACK_PATH) {
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
    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      console.log(`Opening Zendesk authorization:\n${authorizeUrl.toString()}`);
      openBrowser(authorizeUrl.toString());
    });
  });
}

async function exchangeCode(code: string) {
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

function openBrowser(url: string) {
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
    console.log("Could not open a browser automatically. Open the URL above manually.");
  });
  child.unref();
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isTokenResponse(value: unknown): value is OAuthSetupTokenResponse {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as Record<string, unknown>).access_token === "string" &&
      typeof (value as Record<string, unknown>).refresh_token === "string",
  );
}
