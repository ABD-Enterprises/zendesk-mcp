/**
 * The decisions the console makes about the articles a reviewer has already
 * looked at.
 *
 * The module is plain ESM without React, DOM or Vite code, so the test suite
 * can import it directly and check every branch. Reading and writing the
 * browser storage stays in the component.
 */

/** The browser storage the console keeps the reviewed articles in. */
export const REVIEWED_STORAGE_KEY = "knowledge-reviewed";

/**
 * Reads the reviewed articles out of the browser storage.
 *
 * Storage that holds something other than a list of names is treated as an
 * empty list, so a broken entry cannot keep the console from starting.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseReviewed(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item) => typeof item === "string");
}

/**
 * Adds an article to the reviewed list, or takes it off the list.
 *
 * The order of the list stays the order the reviewer worked in.
 *
 * @param {string[]} reviewed
 * @param {string} id
 * @returns {string[]}
 */
export function toggleReviewed(reviewed, id) {
  const current = Array.isArray(reviewed) ? reviewed : [];
  return current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
}

/**
 * Reports whether a reviewer has already looked at an article.
 *
 * @param {string[]} reviewed
 * @param {string} id
 * @returns {boolean}
 */
export function isReviewed(reviewed, id) {
  return Array.isArray(reviewed) && reviewed.includes(id);
}
