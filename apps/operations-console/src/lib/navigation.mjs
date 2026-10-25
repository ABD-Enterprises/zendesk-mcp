/**
 * The decisions the console makes about the section it shows and about the
 * navigation filter.
 *
 * The module is plain ESM without React, DOM or Vite code, so the test suite
 * can import it directly and check every branch.
 */

/** The section the console shows when the address names none. */
export const DEFAULT_SECTION = "overview";

/**
 * Reports whether a navigation entry matches the filter of the sidebar.
 *
 * The filter ignores case, and an empty filter matches every entry.
 *
 * @param {string} label
 * @param {string} query
 * @returns {boolean}
 */
export function matchesQuery(label, query) {
  if (typeof label !== "string") return false;
  const needle = typeof query === "string" ? query.toLowerCase() : "";
  return label.toLowerCase().includes(needle);
}

/**
 * Reads the section out of the location hash of the console.
 *
 * @param {string} hash
 * @returns {string}
 */
export function sectionFromHash(hash) {
  const value = typeof hash === "string" ? hash : "";
  const section = value.startsWith("#") ? value.slice(1) : value;
  return section || DEFAULT_SECTION;
}

/**
 * Names the section the console shows.
 *
 * A section the console does not know has no name, and the top bar leaves it
 * empty.
 *
 * @param {any} items the navigation entries of the console
 * @param {string} section
 * @returns {string | undefined}
 */
export function sectionLabel(items, section) {
  if (!Array.isArray(items)) return undefined;
  const match = items.find((item) => item.id === section);
  return match ? match.label : undefined;
}
