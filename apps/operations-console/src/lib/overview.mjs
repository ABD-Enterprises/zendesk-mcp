/**
 * The state the console derives from an overview payload of the server.
 *
 * The module is plain ESM without React, DOM or Vite code, so the test suite
 * can import it directly and check how an unavailable account is mapped onto
 * the overview the console renders.
 */
import { formatSyncTime } from "./format.mjs";

/**
 * @typedef {object} EmptyOverview
 * @property {boolean} connected
 * @property {string} lastSynced
 * @property {string} accountUrl
 * @property {string} brandId
 * @property {{active: number, untriaged: number, unassigned: number, oldestDays: number}} metrics
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
 * A console that cannot reach its own server and an account it cannot reach
 * are different failures, and only the second one is an OAuth problem. The
 * failure of the console itself is passed in, because the sidebar would
 * otherwise point at the OAuth configuration for a server that never
 * answered.
 *
 * @param {any} overview
 * @param {string | null} [failure] why the console could not reach its server
 * @returns {{connected: boolean, title: string, detail: string}}
 */
export function connectionStatus(overview, failure) {
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
    detail: failure || overview?.error || "Check OAuth configuration",
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

/**
 * The message the console shows when it cannot reach its own server.
 *
 * @type {string}
 */
export const CONSOLE_UNREACHABLE =
  "The console could not reach its server. Check that it is running, then refresh.";

/**
 * Loads the dashboard payload and says why it could not be loaded.
 *
 * A console that cannot reach its server must not answer with zeros: an
 * empty dashboard reads as a quiet account, and the operator cannot tell the
 * two apart. The failure is therefore reported next to the dashboard, not
 * in place of it.
 *
 * A payload the server DID answer with is not a failure of the console. The
 * console answers `503` with `{"connected":false,"error":"…"}` when it cannot
 * reach the account, and that body is a valid answer: the reason is kept on
 * the overview and shown by the sidebar, and no failure is reported.
 *
 * @param {() => Promise<any>} [fetchImpl] the fetch the loader calls
 * @returns {Promise<{overview: any, failure: string | null}>}
 */
export async function loadOverview(fetchImpl = fetch) {
  try {
    const response = await fetchImpl("/api/overview");
    const payload = await response.json();
    return { overview: toOverviewState(payload), failure: null };
  } catch (error) {
    // The reason stays in the console: the browser gets the console's own
    // message, and what caused it is written here.
    console.error("[operations-console] the overview could not be loaded", error);
    return { overview: EMPTY_OVERVIEW, failure: CONSOLE_UNREACHABLE };
  }
}
