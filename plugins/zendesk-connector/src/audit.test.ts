import assert from "node:assert/strict";
import { test } from "node:test";
import { redact } from "./audit.js";

test("redacts sensitive keys recursively without changing ordinary values", () => {
  assert.deepEqual(
    redact({
      message: "Request failed",
      response: { access_token: "secret", nested: { password: "secret", code: 401 } },
    }),
    {
      message: "Request failed",
      response: {
        access_token: "[REDACTED]",
        nested: { password: "[REDACTED]", code: 401 },
      },
    },
  );
});
