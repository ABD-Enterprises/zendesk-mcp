/**
 * Tests for the formatters and the bar scaling of the console frontend.
 *
 * The modules are plain ESM, so the suite imports them without a build step.
 * Every value is invented and nothing here reaches a live account or the
 * public internet.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NOT_CONFIGURED,
  NOT_CONNECTED,
  UNKNOWN_VALUE,
  formatAgeDays,
  formatBrandName,
  formatCount,
  formatSyncTime,
} from "../src/lib/format.mjs";
import { queueBars } from "../src/lib/metrics.mjs";

// The sync label reads the time zone of the machine the suite runs on, so the
// expected label is built the same way instead of being a fixed clock reading.
const SYNCED_AT = "2026-01-02T15:04:05Z";
const syncLabel = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(SYNCED_AT));

test("shows the moment the console synced the account", () => {
  assert.equal(formatSyncTime(SYNCED_AT), syncLabel);
  assert.match(formatSyncTime(SYNCED_AT), /^\d{1,2}:\d{2}\s?(AM|PM)$/);
});

test("reports that the console never synced the account", () => {
  assert.equal(formatSyncTime(""), NOT_CONNECTED);
  assert.equal(formatSyncTime(null), NOT_CONNECTED);
  assert.equal(formatSyncTime(undefined), NOT_CONNECTED);
});

test("shows the age of a ticket in calendar days", () => {
  assert.equal(formatAgeDays(0), "0d");
  assert.equal(formatAgeDays(3), "3d");
  assert.equal(formatAgeDays(12), "12d");
});

test("reports an age the console cannot show", () => {
  assert.equal(formatAgeDays(null), UNKNOWN_VALUE);
  assert.equal(formatAgeDays(undefined), UNKNOWN_VALUE);
  assert.equal(formatAgeDays(Number.NaN), UNKNOWN_VALUE);
  assert.equal(formatAgeDays("3"), UNKNOWN_VALUE);
});

test("shows a count on its own", () => {
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(42), "42");
});

test("reports a count the console cannot show", () => {
  assert.equal(formatCount(null), UNKNOWN_VALUE);
  assert.equal(formatCount(undefined), UNKNOWN_VALUE);
  assert.equal(formatCount(Number.NaN), UNKNOWN_VALUE);
});

test("names the brand the console is scoped to", () => {
  assert.equal(formatBrandName("900000000001"), "900000000001");
  assert.equal(formatBrandName(""), NOT_CONFIGURED);
  assert.equal(formatBrandName(undefined), NOT_CONFIGURED);
});

test("scales the bars of a queue report against the busiest row", () => {
  const bars = queueBars([
    { name: "0-2 days", count: 2 },
    { name: "3-5 days", count: 4 },
  ]);

  assert.deepEqual(bars, [
    { name: "0-2 days", count: 2, percent: 50 },
    { name: "3-5 days", count: 4, percent: 100 },
  ]);
});

test("keeps the bars of an empty report without a division by zero", () => {
  assert.deepEqual(queueBars([]), []);
  assert.deepEqual(queueBars(undefined), []);
});

test("shows a row without tickets as an empty bar", () => {
  assert.deepEqual(queueBars([{ name: "0-2 days", count: 0 }]), [
    { name: "0-2 days", count: 0, percent: 0 },
  ]);
});
