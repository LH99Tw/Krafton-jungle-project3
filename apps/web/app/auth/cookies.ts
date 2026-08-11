import type { NextResponse } from "next/server";

export const CSRF_COOKIE = "fdm_csrf";
export const OAUTH_COOKIE = "fdm_oauth_state";

export function sessionCookieName(): string {
  return process.env.NODE_ENV === "production" ? "__Host-fdm_session" : "fdm_session";
}

export function csrfCookieName(): string {
  return process.env.NODE_ENV === "production" ? "__Host-fdm_csrf" : CSRF_COOKIE;
}

export function oauthCookieName(): string {
  return process.env.NODE_ENV === "production" ? "__Host-fdm_oauth_state" : OAUTH_COOKIE;
}

export function expireAuthCookie(response: NextResponse, name: string, httpOnly: boolean): void {
  response.cookies.set(name, "", {
    httpOnly,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: new Date(0),
    maxAge: 0,
  });
}
