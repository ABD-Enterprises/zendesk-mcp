/**
 * The state the console derives from an overview payload of the server.
 *
 * The module is plain ESM without React, DOM or Vite code, so the test suite
 * can import it directly and check how an unavailable account is mapped onto
 * the overview the console renders.
 */
import { formatCount, formatSyncTime } from "./format.mjs";

/**
 * True when the dashboard describes the whole view.
 *
 * The console reads a view until the view offers no further page, or until it
 * reaches the page limit. When it read the whole view and the account agrees
 * on its size, every figure the console measured is a figure of the whole
 * view. Otherwise the dashboard describes a part of it, or the account's count
 * and the tickets it served disagree.
 *
 * The alert band uses this: it states a fact about the queue only when the
 * dashboard describes the whole queue.
 *
 * @param {any} measured the measurement the payload carries
 * @returns {boolean}
 */
export function measurementIsWhole(measured) {
  if (!measured) return false;
  const read = Number(measured.tickets) || 0;
  const total = measured.total === null || measured.total === undefined
    ? null
    : Number(measured.total);
  if (!measured.complete) return false;
  return total === null || total === read;
}

/**
 * The note the console shows when the dashboard does not describe the whole
 * view, or when the account's count and the tickets it served disagree.
 *
 * The console measures the breakdown of a view from the tickets it read. When
 * the view is longer than the console reads, the breakdown covers only part of
 * it; when the count and the tickets disagree, the console cannot tell which of
 * the two is wrong. The console says so rather than letting a partial
 * measurement read as a whole one.
 *
 * A console that could not reach its server has no measurement to disclose at
 * all: the empty payload it shows is not a measurement of an empty queue, so
 * the note is silent then.
 *
 * @param {any} measured the measurement the payload carries
 * @param {boolean} [connected] whether the console reached the account
 * @returns {string} the note, or "" when there is nothing to disclose
 */
export function measurementNote(measured, connected = true) {
  if (!measured) return "";
  const read = Number(measured.tickets) || 0;
  const total = measured.total === null || measured.total === undefined
    ? null
    : Number(measured.total);
  const complete = Boolean(measured.complete);
  // A console that could not reach its server has no measurement to disclose:
  // the empty payload is not a measurement of an empty queue.
  if (!connected) return "";
  // The whole view was read and the account agrees on its size: every figure
  // the console measured is a figure of the whole view, so there is nothing
  // to disclose.
  if (measurementIsWhole(measured)) return "";

  // The account's count and the tickets it served can disagree. A count below
  // the number of tickets read cannot be a part of the view, and a count above
  // a view the console read to its end cannot be the size of that view. A
  // count that equals the tickets read is too low as well when the console
  // knows the view has a page it did not read.
  const countTooHigh = total !== null && complete && total > read;
  const countTooLow =
    total !== null &&
    (total < read || (total === read && !complete && total > 0));
  // The console read nothing while the view still had a page to offer. The
  // count may well be right — the pages came back empty — so the console
  // does not call it wrong. It says that it measured nothing.
  const countUnmeasured = total !== null && read === 0 && !complete;

  // What the console read.
  const scope = read === 0
    ? complete
      ? "no tickets"
      : "no tickets, and the view has pages the console did not read"
    : complete
      ? `${formatCount(read)} tickets, every ticket the view served`
      : `the first ${formatCount(read)} tickets of the view`;

  const parts = [`The console read ${scope}.`];
  if (total !== null) {
    if (countTooHigh) {
      parts.push(
        `The account says the view holds ${formatCount(total)}, and the view served ${formatCount(read)}, so the two numbers disagree.`,
      );
    } else if (countTooLow) {
      parts.push(
        total < read
          ? `The account says the view holds ${formatCount(total)}, and the console read ${formatCount(read)} tickets, so the two numbers disagree.`
          : `The account says the view holds ${formatCount(total)}, and the view has pages the console did not read, so the count cannot be the size of the view.`,
      );
    } else if (countUnmeasured) {
      parts.push(
        `The account says the view holds ${formatCount(total)}, and the pages the console read served no tickets, so the console measured nothing.`,
      );
    } else {
      parts.push(`The account says the view holds ${formatCount(total)}.`);
    }
  }
  if (total === null) {
    // The account states no count, so the active figure is the number of
    // tickets the console read. The console did not read the whole view, so
    // that number is a floor rather than the size of the view.
    parts.push(
      "The active figure is the number of tickets the console read, so it is a floor rather than the size of the view.",
    );
  } else {
    parts.push(
      "The active figure is the account's count of the view, not a number the console measured.",
    );
  }
  parts.push(
    "The unassigned figure, the oldest ticket and the breakdowns are measured from the tickets that were read, and the triage figure is the account's count of the untriaged view.",
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
 * Sequences the console's loads.
 *
 * Two loads can overlap: React's development double-mount runs the mount
 * load twice, and the older of the two may settle last. A failure the older
 * one reports would then replace a success that came after it, and the
 * console would show a failure for an account that is reachable. The refresh
 * button is disabled while the newest load runs, so a refresh starts a load
 * only after the newest has settled; a superseded load can still be in
 * flight at that moment, and the double-mount is what put it there.
 *
 * The sequence hands out a number for every load and says which of them is
 * still the newest, so that only the newest may write.
 *
 * @returns {{begin: () => number, isCurrent: (id: number) => boolean}}
 */
export function createLoadSequence() {
  let current = 0;
  return {
    begin() {
      current += 1;
      return current;
    },
    isCurrent(id) {
      return id === current;
    },
  };
}

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
