/**
 * The OAuth modes the connector supports.
 *
 * The type, the list and the predicate that checks a value against the list
 * live in this module, and not in `auth.ts`, so every module that validates
 * a mode can share one definition without importing another module that
 * imports back: `auth.ts` (the configuration) and `oauth:setup.ts` (the
 * setup) both read the list from here.
 */

/** The OAuth modes the connector can authenticate with. */
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

/**
 * True when a value names one of the supported OAuth modes.
 *
 * This is the only check for a mode: the configuration and the setup both
 * use it, so a mode added to `OAUTH_MODES` is accepted by both at once.
 */
export function isOAuthMode(value: string): value is OAuthMode {
  return (OAUTH_MODES as readonly string[]).includes(value);
}
