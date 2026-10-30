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
 * and the tickets it served disagree, and the console has to say so.
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
 * @param {any} measured the measurement the payload carries
 * @returns {string} the note, or "" when the dashboard describes the whole view
 */
export function measurementNote(measured) {
  if (!measured) return "";
  const read = Number(measured.tickets) || 0;
  const total = measured.total === null || measured.total === undefined
    ? null
    : Number(measured.total);
  const complete = Boolean(measured.complete);
  // The whole view was read and the account agrees on its size: every figure
  // the console measured is a figure of the whole view, so there is nothing
  // to disclose.
  if (measurementIsWhole(measured)) return "";
  // Nothing was measured and the account states no count. That is the
  // signature of a console that could not reach its server: there is no
  // measurement to disclose, and a note that says the console read no tickets
  // would read as a measurement of an empty queue.
  if (read === 0 && total === null && !complete) return "";

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
  const countUnmeasured =
    total !== null && read === 0 && !complete && total > 0;

  // What the console read.
  const scope = read === 0
    ? "no tickets"
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
          : `The account says the view holds ${formatCount(total)}, and the view has pages the console did not read, so the two numbers disagree.`,
      );
    } else if (countUnmeasured) {
      parts.push(
        `The account says the view holds ${formatCount(total)}, and the pages the console read served no tickets.`,
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
