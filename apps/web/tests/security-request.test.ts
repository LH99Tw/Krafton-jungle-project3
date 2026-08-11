import assert from "node:assert/strict";
import test from "node:test";
import { hasAllowedOrigin } from "../app/security/request";

test("production mutations require an explicitly allowed Origin", () => {
  const mutableEnv = process.env as Record<string, string | undefined>;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAllowedOrigins = process.env.ALLOWED_ORIGINS;
  mutableEnv.NODE_ENV = "production";
  mutableEnv.ALLOWED_ORIGINS = "https://web.example.com";
  try {
    assert.equal(hasAllowedOrigin(new Request("https://web.example.com/api/guestbook", {
      headers: { origin: "https://web.example.com" },
    })), true);
    assert.equal(hasAllowedOrigin(new Request("https://web.example.com/api/guestbook", {
      headers: { origin: "https://evil.example" },
    })), false);
    assert.equal(hasAllowedOrigin(new Request("https://web.example.com/api/guestbook")), false);
  } finally {
    if (originalNodeEnv === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = originalNodeEnv;
    if (originalAllowedOrigins === undefined) delete mutableEnv.ALLOWED_ORIGINS;
    else mutableEnv.ALLOWED_ORIGINS = originalAllowedOrigins;
  }
});
