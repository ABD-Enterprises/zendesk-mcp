/**
 * The formatters the console frontend uses.
 *
 * The module is plain ESM without React, DOM or Vite code, so the test suite
 * can import it directly and check every branch of every formatter.
 */

/** The label the sidebar shows when the console knows no sync time. */
export const NOT_CONNECTED = "Not connected";

/** The placeholder the console shows for a value it cannot compute. */
export const UNKNOWN_VALUE = "—";

/** The label the intake page shows when no brand is configured. */
export const NOT_CONFIGURED = "Not configured";

/**
 * Formats the moment the console last synced the account.
 *
 * An empty value means the console never synced the account, so the label
 * says so instead of showing a time.
 *
 * @param {string} value
 * @returns {string}
 */
export function formatSyncTime(value) {
  if (!value) return NOT_CONNECTED;
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

/**
 * Formats the age of a ticket in calendar days.
 *
 * @param {number} days
 * @returns {string}
 */
export function formatAgeDays(days) {
  return typeof days === "number" && Number.isFinite(days) ? `${days}d` : UNKNOWN_VALUE;
}

/**
 * Formats a count the console shows on its own, such as a metric card.
 *
 * @param {number} count
 * @returns {string}
 */
export function formatCount(count) {
  return typeof count === "number" && Number.isFinite(count) ? String(count) : UNKNOWN_VALUE;
}

/**
 * Names the brand the console is scoped to.
 *
 * @param {string} brandId
 * @returns {string}
 */
export function formatBrandName(brandId) {
  return brandId || NOT_CONFIGURED;
}
