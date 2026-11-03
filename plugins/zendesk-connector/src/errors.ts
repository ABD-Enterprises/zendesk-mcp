/**
 * The message of a failure, without a stack trace.
 *
 * A failure reaches an operator as one line, so the modules that report one
 * share this helper: an `Error` contributes its message, and anything else
 * its string form.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
