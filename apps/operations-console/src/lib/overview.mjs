/**
 * The state the console derives from an overview payload of the server.
 *
 * The module is plain ESM without React, DOM or Vite code, so the test suite
 * can import it directly and check how an unavailable account is mapped onto
 * the overview the console renders.
 */
import { formatCount, formatSyncTime } from "./format.mjs";

/**
 * The note the console shows when it did not measure the whole view, or when
 * the account's count and the tickets it served disagree.
 *
 * The console measures the breakdown of a view from the tickets it read. When
 * the view is longer than the console reads, the breakdown covers only part of
 * it; when the count and the tickets disagree, the console cannot tell which of
 * the two is wrong. The console says so rather than letting a partial
 * measurement read as a whole one.
 *
 * @param {any} measured the measurement the payload carries
 * @returns {string} the note, or "" when there is nothing to disclose
 */
export function measurementNote(measured) {
  if (!measured) return "";
  const read = Number(measured.tickets) || 0;
  // Nothing was measured, so there is no partial measurement to disclose.
  if (read === 0) return "";
  const total = measured.total === null || measured.total === undefined
    ? null
    : Number(measured.total);
  const complete = Boolean(measured.complete);
  // The console read the whole view and the account agrees on its size, so
  // there is nothing to disclose.
  if (complete && (total === null || total === read)) return "";

  // The account's count and the tickets it served can disagree. A count below
  // the number of tickets read cannot be a part of the view, and a count above
  // a view the console read to its end cannot be the size of that view. In
  // both cases the count is the number that cannot be trusted, so the note
  // names the disagreement instead of calling the measurement a part of the
  // view.
  const countDisagrees =
    total !== null && (total < read || (complete && total > read));

  // What the console read.
  const scope = countDisagrees
    ? complete
      ? `${formatCount(read)} tickets, every ticket the view served`
      : `the first ${formatCount(read)} tickets of the view`
    : total !== null && total > read
      ? `the first ${formatCount(read)} of the ${formatCount(total)} tickets in the view`
      : `the first ${formatCount(read)} tickets of the view`;

  const parts = [`The console read ${scope}.`];
  if (countDisagrees) {
    parts.push(
      `The account says the view holds ${formatCount(total)}, and the two numbers disagree.`,
    );
  }
  if (total === null) {
    // The account states no count, so the active figure is the number of
    // tickets the console read. The console did not read the whole view, so
    // that number is a floor rather than the size of the view.
    parts.push(
      "The active figure counts only the tickets the console read, so it is a floor rather than the size of the view.",
    );
  }
  parts.push(
    "The unassigned figure, the oldest ticket and the breakdowns are measured from the tickets that were read.",
  );
  return parts.join(" ");
}

/**
 * @typedef {object} EmptyOverview
 * @property {boolean} connected
 * @property {string} lastSynced
 * @property {string} accountUrl
 * @property {string} brandId
 * @property {{active: number, untriaged: number, unassigned: number, oldestDays: number}} metrics
 * @property {{tickets: number, total: number | null, complete: boolean}} measured
 * @property {Array<{name: string, count: number}>} aging
 * @property {Array<{name: string, count: number}>} requestTypes
 * @property {Array<any>} tickets
 * @property {Record<string, string>} views
 */

/**
 * The overview the console shows while the account is unreachable.
 *
 * @type {EmptyOverview}
 */
export const EMPTY_OVERVIEW = {
  connected: false,
  lastSynced: "",
  accountUrl: "https://example.zendesk.com",
  brandId: "",
  metrics: { active: 0, untriaged: 0, unassigned: 0, oldestDays: 0 },
  measured: { tickets: 0, total: null, complete: false },
  aging: [],
  requestTypes: [],
  tickets: [],
  views: {},
};

/**
 * Maps a payload of the server onto the overview the console renders.
 *
 * A payload that reports a reachable account is kept as it is. A payload that
 * reports an unreachable account becomes the empty overview with the message
 * of the server attached, so the console shows the reason instead of the
 * numbers of a previous sync.
 *
 * @param {any} payload
 * @returns {any}
 */
export function toOverviewState(payload) {
  if (payload && payload.connected) return payload;
  return { ...EMPTY_OVERVIEW, error: payload?.error };
}

/**
 * Describes the account the console is connected to.
 *
 * @param {any} overview
 * @returns {{connected: boolean, title: string, detail: string}}
 */
export function connectionStatus(overview) {
  const connected = Boolean(overview && overview.connected);
  if (connected) {
    return {
      connected,
      title: "Zendesk connected",
      detail: `Synced ${formatSyncTime(overview.lastSynced)}`,
    };
  }
  return {
    connected,
    title: "Zendesk unavailable",
    detail: overview?.error || "Check OAuth configuration",
  };
}

/**
 * Builds the link to a view of the account.
 *
 * A view the console does not know about, or one the server left empty, has
 * no link to offer, so the link stays inside the console.
 *
 * @param {any} views
 * @param {string} name
 * @returns {string}
 */
export function viewHref(views, name) {
  const href = views ? views[name] : "";
  return typeof href === "string" && href !== "" ? href : "#";
}

/**
 * Builds the link to the open queue of the account.
 *
 * Without a view the console sends the agent to the ticket list of the
 * account instead.
 *
 * @param {any} overview
 * @returns {string}
 */
export function openQueueHref(overview) {
  const href = viewHref(overview?.views, "open");
  return href === "#" ? `${overview?.accountUrl}/agent/home/tickets` : href;
}
