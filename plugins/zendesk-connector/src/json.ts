/**
 * Parses JSON, and falls back to the raw text when it is not JSON.
 *
 * A response body that is not JSON is kept exactly as it arrived, so a
 * caller can report it the way the endpoint sent it instead of losing it to
 * a parse error. The helper is shared by the modules that read a Zendesk
 * response body, so the fallback is the same everywhere.
 */
export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
