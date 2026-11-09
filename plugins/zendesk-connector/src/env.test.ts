import assert from "node:assert/strict";
import { test } from "node:test";
import { env } from "./env.js";

test("returns the trimmed value", () => {
  assert.equal(env("VALUE", { VALUE: "  example  " }), "example");
});

test("treats an absent value as unset", () => {
  assert.equal(env("VALUE", {}), undefined);
});

test("treats an empty or whitespace-only value as unset", () => {
  assert.equal(env("VALUE", { VALUE: "" }), undefined);
  assert.equal(env("VALUE", { VALUE: "   " }), undefined);
});

test("treats a literal placeholder value as unset", () => {
  assert.equal(env("VALUE", { VALUE: "${EXAMPLE}" }), undefined);
  assert.equal(env("VALUE", { VALUE: "  ${EXAMPLE}  " }), undefined);
});

test("keeps a value that merely contains a placeholder", () => {
  assert.equal(env("VALUE", { VALUE: "prefix-${EXAMPLE}" }), "prefix-${EXAMPLE}");
});

test("reads the process environment by default", () => {
  const original = process.env.ENV_TEST_PROBE;
  try {
    delete process.env.ENV_TEST_PROBE;
    assert.equal(env("ENV_TEST_PROBE"), undefined);
    process.env.ENV_TEST_PROBE = " probe ";
    assert.equal(env("ENV_TEST_PROBE"), "probe");
  } finally {
    if (original === undefined) delete process.env.ENV_TEST_PROBE;
    else process.env.ENV_TEST_PROBE = original;
  }
});
