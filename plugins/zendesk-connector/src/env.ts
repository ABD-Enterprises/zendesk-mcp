/**
 * The connector's one rule for reading an environment variable.
 *
 * Connector `ZENDESK_*` settings use {@link env} unless they are one of the
 * explicit exceptions below. For those settings, a value means the same
 * thing wherever it is read: the value is trimmed, and an empty value or a
 * value that consists of exactly an unsubstituted `${...}` placeholder counts
 * as unset — a templating step that failed leaves the connector unconfigured
 * instead of authenticating with a literal placeholder string.
 *
 * Two cases deliberately use separate readers, and both are documented in
 * `docs/secrets-and-storage.md`:
 *
 * - `ZENDESK_OAUTH_CALLBACK_PORT` (`auth.ts`) is read raw and strictly: a
 *   blank, placeholder or non-decimal value is an error, not unset, because
 *   `oauth:setup` and the doctor must report the same failure for the same
 *   input. It never routes through {@link env}.
 * - The operations console is a separate app with its own `configValue()`
 *   that mirrors this rule for its own `ZENDESK_CONSOLE_*` settings; it
 *   deliberately does not read the connector's account or credential
 *   variables, so an exported `ZENDESK_BASE_URL` cannot redirect the client
 *   secret to a different account.
 *
 * What an unset value means is a per-variable policy decided by the reader:
 * most settings fall back to the saved client file or a default, while
 * `ZENDESK_READ_ONLY`, `ZENDESK_ALLOWED_TOOLS` and `ZENDESK_OAUTH_MODE`
 * validate their value and throw on an unusable one.
 */

/**
 * Reads a trimmed env value; empty and literal `${...}` placeholders count
 * as unset. `source` defaults to the process environment and exists so
 * readers that accept an injectable environment map (the healthcheck and
 * shutdown readers, in tests) share this helper instead of re-implementing
 * its trimming and placeholder rule.
 */
export function env(
  name: string,
  source: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = source[name]?.trim();
  return value && !/^\$\{[^}]+\}$/.test(value) ? value : undefined;
}
