import { hashToken } from "@five-days/auth";
import { revokeSession } from "@five-days/db/repositories";
import { NextResponse } from "next/server";
import {
  CSRF_COOKIE,
  csrfCookieName,
  expireAuthCookie,
  sessionCookieName,
} from "@/app/auth/session";
import { clientIp, consumeRateLimit, hasAllowedOrigin, rateLimited } from "@/app/security/request";

export async function POST(request: Request) {
  // Logout is safe to retry and only removes credentials. Requiring a valid
  // same-origin request avoids forced cross-site logout without making logout
  // depend on a possibly stale CSRF token.
  if (!hasAllowedOrigin(request, true)) {
    return Response.json({ error: { code: "CSRF_INVALID", message: "요청을 확인할 수 없습니다." } }, { status: 403 });
  }
  const decision = consumeRateLimit("logout-ip", clientIp(request), { capacity: 20, refillMs: 60_000 });
  if (!decision.allowed) return rateLimited(decision.retryAfterSeconds);
  const token = readCookie(request.headers.get("cookie") ?? "", sessionCookieName());
  const response = NextResponse.json({ ok: true });
  expireAuthCookie(response, sessionCookieName(), true);
  expireAuthCookie(response, csrfCookieName(), false);
  if (csrfCookieName() !== CSRF_COOKIE) expireAuthCookie(response, CSRF_COOKIE, false);
  if (token) {
    try {
      await revokeSession(hashToken(token));
    } catch (error) {
      // Local logout must still remove the browser credentials when the
      // session store is temporarily unavailable.
      console.error("Failed to revoke auth session during logout", error);
    }
  }
  return response;
}

function readCookie(header: string, name: string): string | undefined {
  return header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}
