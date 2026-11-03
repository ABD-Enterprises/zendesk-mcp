import { z } from "zod";

/**
 * Runtime validation for Zendesk response envelopes: issue #50. Every
 * structured response consumed by server.ts is checked: the six collection
 * envelopes behind the list tools, the search results array, the named
 * object envelopes behind the status and ticket tools, and the comments
 * array. Ids, count and pagination fields are not tightened, and side-loaded
 * optional fields are never required.
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
 * callers return the payload untouched, so unknown fields survive. An
 * empty array is accepted.
 */
export function isCollectionEnvelope(payload: unknown, key: string): boolean {
  return z
    .looseObject({ [key]: z.array(opaqueRecord) })
    .safeParse(payload).success;
}

/**
 * Returns true when payload is a JSON object holding an opaque object
 * record under `key`. The named property must be an object: a scalar, an
 * array or null is rejected, while an empty object is accepted. Unknown
 * envelope fields are allowed and survive untouched.
 */
export function isObjectEnvelope(payload: unknown, key: string): boolean {
  return z.looseObject({ [key]: opaqueRecord }).safeParse(payload).success;
}
