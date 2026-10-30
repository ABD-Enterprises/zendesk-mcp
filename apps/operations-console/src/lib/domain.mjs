/**
 * The names the console uses when the account does not carry one.
 *
 * The server counts a ticket without a request type as unclassified and sends
 * that name along; the frontend falls back to the same names. They live in
 * one module so the two halves of the console cannot drift apart.
 */

/** The request type a ticket carries when the console cannot read one. */
export const UNCLASSIFIED_REQUEST_TYPE = "Unclassified";

/** The system a ticket belongs to when the console cannot read one. */
export const UNSPECIFIED_SYSTEM = "Not specified";
