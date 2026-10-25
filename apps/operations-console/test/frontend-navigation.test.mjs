/**
 * Tests for the decisions the console makes about the section it shows, about
 * the navigation filter and about the articles a reviewer already looked at.
 *
 * The modules are plain ESM, so the suite imports them without a build step.
 * Every value is invented and nothing here reaches a live account or the
 * public internet.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isReviewed, parseReviewed, toggleReviewed } from "../src/lib/knowledge.mjs";
import { matchesQuery, sectionFromHash, sectionLabel } from "../src/lib/navigation.mjs";

const NAVIGATION = [
  { id: "overview", label: "Overview" },
  { id: "intake", label: "Intake & routing" },
  { id: "reports", label: "Queue reports" },
];

test("matches a navigation entry without case", () => {
  assert.equal(matchesQuery("Queue reports", "queue"), true);
  assert.equal(matchesQuery("Queue reports", "QUEUE"), true);
  assert.equal(matchesQuery("Queue reports", "intake"), false);
});

test("keeps every navigation entry for an empty filter", () => {
  assert.equal(matchesQuery("Queue reports", ""), true);
  assert.equal(matchesQuery("Overview", ""), true);
});

test("reads the section out of the location hash", () => {
  assert.equal(sectionFromHash("#reports"), "reports");
  assert.equal(sectionFromHash("reports"), "reports");
  assert.equal(sectionFromHash(""), "overview");
  assert.equal(sectionFromHash("#"), "overview");
  assert.equal(sectionFromHash(undefined), "overview");
});

test("names the section the console shows", () => {
  assert.equal(sectionLabel(NAVIGATION, "reports"), "Queue reports");
  assert.equal(sectionLabel(NAVIGATION, "unknown"), undefined);
  assert.equal(sectionLabel([], "reports"), undefined);
});

test("reads the reviewed articles out of the browser storage", () => {
  assert.deepEqual(parseReviewed('["training","scope"]'), ["training", "scope"]);
  assert.deepEqual(parseReviewed("[]"), []);
});

test("reads an empty or broken browser storage as no reviewed article", () => {
  assert.deepEqual(parseReviewed(null), []);
  assert.deepEqual(parseReviewed(undefined), []);
  assert.deepEqual(parseReviewed(""), []);
  assert.deepEqual(parseReviewed("not json"), []);
  assert.deepEqual(parseReviewed('{"training":true}'), []);
  assert.deepEqual(parseReviewed('["training",7]'), ["training"]);
});

test("adds an article to the reviewed list", () => {
  assert.deepEqual(toggleReviewed([], "training"), ["training"]);
  assert.deepEqual(toggleReviewed(["training"], "scope"), ["training", "scope"]);
});

test("takes an article off the reviewed list", () => {
  assert.deepEqual(toggleReviewed(["training", "scope"], "training"), ["scope"]);
});

test("keeps the order the reviewer worked in", () => {
  const reviewed = ["scope"];

  assert.deepEqual(toggleReviewed(reviewed, "training"), ["scope", "training"]);
  assert.deepEqual(reviewed, ["scope"], "the list the reviewer started from stays untouched");
});

test("reports an article the reviewer already looked at", () => {
  assert.equal(isReviewed(["training"], "training"), true);
  assert.equal(isReviewed(["training"], "scope"), false);
  assert.equal(isReviewed([], "training"), false);
});
