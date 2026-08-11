import assert from "node:assert/strict";
import test from "node:test";
import { NextResponse } from "next/server";
import { csrfCookieName, expireAuthCookie, sessionCookieName } from "../app/auth/cookies";

test("production auth cookie expiration preserves __Host requirements", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const mutableEnv = process.env as Record<string, string | undefined>;
  mutableEnv.NODE_ENV = "production";
  try {
    const response = NextResponse.json({ ok: true });
    expireAuthCookie(response, sessionCookieName(), true);
    expireAuthCookie(response, csrfCookieName(), false);

    const setCookie = response.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /__Host-fdm_session=;/);
    assert.match(setCookie, /__Host-fdm_csrf=;/);
    assert.match(setCookie, /Path=\//);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /Max-Age=0/);
  } finally {
    if (originalNodeEnv === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = originalNodeEnv;
  }
});
