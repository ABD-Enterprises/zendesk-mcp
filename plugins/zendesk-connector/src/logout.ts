import { resolve } from "node:path";
import {
  logOAuthLogout,
  type LogSink,
  type OAuthLogoutEvent,
  type StoredCredentialsState,
} from "./audit.js";
import {
  ZendeskOAuth,
  getConfig,
  oauthClientFilePath,
  removeTokenFile,
  resolveTokenFile,
  revokeCurrentToken,
  type OAuthMode,
  type OAuthRequester,
  type RevocationResult,
  type ZendeskConfig,
} from "./auth.js";
import { ZendeskClient } from "./client.js";

export interface LogoutOptions {
  /** The configuration to log out of. Defaults to the environment. */
  config?: ZendeskConfig;
  /** Issues the revocation request. Defaults to the shared request plumbing. */
  request?: OAuthRequester;
  /** The authentication state that is cleared. Defaults to a new instance. */
  auth?: ZendeskOAuth;
  /** Receives the audit event. Defaults to stderr. */
  sink?: LogSink;
}

export interface RunLogoutOptions extends LogoutOptions {
  /** Writes the summary to stdout. */
  writeOut?: (line: string) => void;
  /** Writes the failure summary to stderr. */
  writeError?: (line: string) => void;
}

export interface LogoutResult {
  /** True when Zendesk confirmed that the token was revoked. */
  revoked: boolean;
  /** The HTTP status Zendesk returned, undefined when no answer arrived. */
  status?: number;
  /** Why the logout did not fully succeed. */
  error?: string;
  /** True when the in-memory token cache was cleared. */
  cacheCleared: boolean;
  /** What happened to the persisted OAuth token file. */
  storedCredentials: StoredCredentialsState;
  /** The OAuth mode that was logged out of. */
  mode?: OAuthMode;
}

/** The configuration a logout runs with, and why it may be incomplete. */
interface ResolvedConfig {
  /** The loaded configuration, undefined when it could not be read. */
  config?: ZendeskConfig;
  /** The path of the persisted OAuth token file. */
  tokenFile: string;
  /** Why the configuration could not be read. */
  error?: string;
}

/**
 * Logs the connector out of the Zendesk OAuth session.
 *
 * The remote revocation is best effort: a failure there is reported but never
 * stops the local cleanup. The local cleanup is definite: the in-memory token
 * cache is cleared and the persisted token file is removed. The OAuth client
 * file holds the client credentials and is never touched.
 *
 * Concurrent calls share one run, so the revocation request and the audit
 * event happen once.
 */
export class ZendeskLogout {
  private inFlight?: Promise<LogoutResult>;

  constructor(private readonly options: LogoutOptions = {}) {}

  run(): Promise<LogoutResult> {
    if (!this.inFlight) {
      this.inFlight = this.execute().finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  private async execute(): Promise<LogoutResult> {
    const resolved = this.resolveConfig();
    const client = resolved.config
      ? new ZendeskClient(resolved.config)
      : undefined;
    const auth =
      this.options.auth ??
      client?.auth ??
      new ZendeskOAuth({
        baseUrl: "",
        mode: "authorization_code",
        tokenFile: resolved.tokenFile,
        scope: "",
      });
    const request =
      this.options.request ??
      (client
        ? (
            path: string,
            options: { method: "GET" | "POST" | "PUT" | "DELETE" },
          ) => client.request(path, options)
        : undefined);

    const revocation: RevocationResult = request
      ? await revokeCurrentToken(request)
      : {
          revoked: false,
          error: `Zendesk OAuth configuration is unavailable: ${
            resolved.error ?? "unknown configuration error"
          }`,
        };

    await auth.clearToken();

    const removal = await this.removeStoredCredentials(resolved.tokenFile);
    const error = [revocation.error, removal.error].filter(Boolean).join("; ");

    const event: Omit<OAuthLogoutEvent, "event" | "timestamp"> = {
      outcome: revocation.revoked && !error ? "success" : "error",
      revoked: revocation.revoked,
      clearedCache: true,
      storedCredentials: removal.state,
    };
    if (resolved.config) event.mode = resolved.config.mode;
    if (revocation.status !== undefined) event.status = revocation.status;
    if (error) event.error = error;
    logOAuthLogout(event, this.options.sink);

    const result: LogoutResult = {
      revoked: revocation.revoked,
      cacheCleared: true,
      storedCredentials: removal.state,
    };
    if (revocation.status !== undefined) result.status = revocation.status;
    if (error) result.error = error;
    if (resolved.config) result.mode = resolved.config.mode;
    return result;
  }

  private resolveConfig(): ResolvedConfig {
    if (this.options.config) {
      return {
        config: this.options.config,
        tokenFile: this.options.config.tokenFile,
      };
    }
    try {
      const config = getConfig();
      return { config, tokenFile: config.tokenFile };
    } catch (error) {
      // An incomplete configuration only prevents the remote revocation. The
      // local credentials are cleared either way.
      return {
        tokenFile: resolveTokenFile(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async removeStoredCredentials(
    tokenFile: string,
  ): Promise<{ state: StoredCredentialsState; error?: string }> {
    if (resolve(tokenFile) === resolve(oauthClientFilePath())) {
      return {
        state: "kept",
        error:
          "The configured token file is the OAuth client file; it was left in place.",
      };
    }
    try {
      const removed = await removeTokenFile(tokenFile);
      return { state: removed ? "removed" : "absent" };
    } catch (error) {
      return {
        state: "kept",
        error: `Unable to remove the stored OAuth credentials: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }
}

/** Reports whether the process was asked to log out of the OAuth session. */
export function isLogoutRequested(
  argv: string[] = process.argv.slice(2),
): boolean {
  return argv.includes("--logout");
}

/** Runs the logout and returns the exit code for the process. */
export async function runLogout(
  options: RunLogoutOptions = {},
): Promise<number> {
  const result = await new ZendeskLogout(options).run();
  const writeOut =
    options.writeOut ?? ((line: string) => void process.stdout.write(line));
  const writeError =
    options.writeError ?? ((line: string) => void process.stderr.write(line));

  if (result.revoked && result.storedCredentials !== "kept") {
    writeOut(
      result.storedCredentials === "removed"
        ? "Zendesk OAuth logout complete: the token was revoked and the stored credentials were removed.\n"
        : "Zendesk OAuth logout complete: the token was revoked and no stored credentials were present.\n",
    );
    return 0;
  }

  writeError(
    `Zendesk OAuth logout incomplete: ${
      result.error ?? "the token was not revoked remotely."
    }\n`,
  );
  return 1;
}
