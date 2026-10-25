/**
 * The scaling the console applies to the bars of a queue report.
 *
 * The module is plain ESM without React, DOM or Vite code, so the test suite
 * can import it directly and check the width of every bar.
 */

/**
 * Scales the rows of a queue metric against the busiest row.
 *
 * An empty report still has a scale of one, so a row never divides by zero.
 * The percentage is the share of the busiest row, which is what the bar of
 * the console shows.
 *
 * @param {any} data the rows of a queue metric, each with a name and a count
 * @returns {Array<{name: any, count: any, percent: number}>}
 */
export function queueBars(data) {
  const rows = Array.isArray(data) ? data : [];
  const max = Math.max(1, ...rows.map((item) => item.count));
  return rows.map((item) => ({
    name: item.name,
    count: item.count,
    percent: (item.count / max) * 100,
  }));
}
