import { z } from "zod";

/**
 * Runtime validation for Zendesk collection envelopes: the first slice of
 * issue #50. Only the six envelopes behind the brands, groups, users,
 * organizations, ticket_fields and ticket_forms list tools are checked
 * here; search, ticket and comment responses stay unvalidated in this
 * slice, and ids, count and pagination fields are not tightened.
 */

/**
 * An opaque JSON object record. Records may carry any fields — including
 * ones this connector does not know — but each element of a collection
 * must be an object rather than a scalar, an array or null.
 */
const opaqueRecord = z.record(z.string(), z.unknown());

/**
 * Returns true when payload is a JSON object holding an array of opaque
 * object records under `key`. Unknown envelope fields are allowed, and
 * callers return the payload untouched, so unknown fields survive.
 */
export function isCollectionEnvelope(payload: unknown, key: string): boolean {
  return z
    .looseObject({ [key]: z.array(opaqueRecord) })
    .safeParse(payload).success;
}
