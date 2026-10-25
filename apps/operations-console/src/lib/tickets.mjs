/**
 * The classification the console applies to the tickets of a report.
 *
 * The module is plain ESM without React, DOM or Vite code, so the test suite
 * can import it directly and check how a ticket is named.
 */
import { formatAgeDays } from "./format.mjs";

/** The request type a ticket carries when the console cannot read one. */
export const UNCLASSIFIED_REQUEST_TYPE = "Unclassified";

/** The system a ticket belongs to when the console cannot read one. */
export const UNSPECIFIED_SYSTEM = "Not specified";

/**
 * Names the request type of a ticket.
 *
 * The server counts a ticket without a request type as unclassified and sends
 * that name along, so the console keeps the name of the ticket and only falls
 * back to the unclassified name when the field is empty.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function requestTypeLabel(value) {
  if (typeof value !== "string") return UNCLASSIFIED_REQUEST_TYPE;
  return value.trim() === "" ? UNCLASSIFIED_REQUEST_TYPE : value;
}

/**
 * Names the system a ticket belongs to.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function systemLabel(value) {
  if (typeof value !== "string") return UNSPECIFIED_SYSTEM;
  return value.trim() === "" ? UNSPECIFIED_SYSTEM : value;
}

/**
 * Reports whether a ticket has an owner.
 *
 * @param {any} ticket
 * @returns {{label: string, assigned: boolean}}
 */
export function assignmentState(ticket) {
  const assigned = Boolean(ticket && ticket.assigneeId);
  return { label: assigned ? "Assigned" : "Unassigned", assigned };
}

/**
 * @typedef {object} TicketRow
 * @property {any} id
 * @property {string} title
 * @property {any} url
 * @property {string} age
 * @property {any} status
 * @property {string} requestType
 * @property {string} system
 * @property {{label: string, assigned: boolean}} assignment
 */

/**
 * Builds the row the reports table shows for a ticket.
 *
 * @param {any} ticket
 * @returns {TicketRow}
 */
export function ticketRow(ticket) {
  return {
    id: ticket.id,
    title: `#${ticket.id} · ${ticket.subject}`,
    url: ticket.url,
    age: formatAgeDays(ticket.ageDays),
    status: ticket.status,
    requestType: requestTypeLabel(ticket.requestType),
    system: systemLabel(ticket.system),
    assignment: assignmentState(ticket),
  };
}
