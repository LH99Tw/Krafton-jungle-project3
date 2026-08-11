import { hashToken, randomToken } from "@five-days/auth";
import { createGuestUser, createSession } from "@five-days/db/repositories";
import { isSafePublicText, normalizePublicText } from "@five-days/protocol";
import { NextResponse } from "next/server";
import { csrfCookieName, sessionCookieName } from "@/app/auth/session";
import {
  clientIp,
  consumeRateLimit,
  hasAllowedOrigin,
  payloadError,
  rateLimited,
  readJsonLimited,
  securityNumber,
} from "@/app/security/request";

export async function POST(request: Request) {
  const enabled = process.env.PUBLIC_PLAYTEST_ENABLED === "true" || process.env.NODE_ENV !== "production";
  if (!enabled) return Response.json({ error: { code: "GUEST_DISABLED", message: "게스트 접속이 비활성화되어 있습니다." } }, { status: 403 });
  if (!hasAllowedOrigin(request)) {
    return Response.json({ error: { code: "ORIGIN_INVALID", message: "요청 오리진을 확인할 수 없습니다." } }, { status: 403 });
  }
  const ip = clientIp(request);
  for (const decision of [
    consumeRateLimit("guest-short", ip, { capacity: securityNumber("GUEST_10M_LIMIT", 10), refillMs: 10 * 60_000 }),
    consumeRateLimit("guest-daily", ip, { capacity: securityNumber("GUEST_DAILY_LIMIT", 50), refillMs: 86_400_000 }),
    consumeRateLimit("guest-global", "all", { capacity: securityNumber("GUEST_GLOBAL_DAILY_LIMIT", 500), refillMs: 86_400_000 }),
  ]) {
    if (!decision.allowed) return rateLimited(decision.retryAfterSeconds);
  }
  let body: { displayName?: unknown };
  try {
    body = await readJsonLimited<{ displayName?: unknown }>(request, 2048);
  } catch (error) {
    return payloadError(error) ?? Response.json({ error: { code: "INVALID_BODY", message: "이름을 입력해 주세요." } }, { status: 400 });
  }
  const displayName = typeof body.displayName === "string" ? normalizePublicText(body.displayName) : "";
  if (displayName.length < 2 || displayName.length > 6 || !isSafePublicText(displayName)) {
    return Response.json({ error: { code: "INVALID_NAME", message: "이름은 2~6자의 안전한 문자로 입력해 주세요." } }, { status: 400 });
  }
  try {
    const user = await createGuestUser({ displayName });
    const sessionToken = randomToken();
    const csrfToken = randomToken();
    const maxAge = 24 * 60 * 60;
    await createSession({
      userId: user.id,
      tokenHash: hashToken(sessionToken),
      encryptedRefreshToken: null,
      expiresAt: new Date(Date.now() + maxAge * 1000),
    });
    const response = NextResponse.json({
      viewer: { userId: user.id, displayName: user.displayName, accountType: "guest" as const },
      csrfToken,
    });
    response.cookies.set(sessionCookieName(), sessionToken, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge });
    response.cookies.set(csrfCookieName(), csrfToken, { httpOnly: false, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge });
    return response;
  } catch {
    if (process.env.NODE_ENV !== "production") {
      const devUserId = "dev-guest-" + Date.now();
      const sessionToken = randomToken();
      const csrfToken = randomToken();
      const maxAge = 24 * 60 * 60;
      const response = NextResponse.json({
        viewer: { userId: devUserId, displayName, accountType: "guest" as const },
        csrfToken,
      });
      response.cookies.set(sessionCookieName(), sessionToken, { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge });
      response.cookies.set(csrfCookieName(), csrfToken, { httpOnly: false, secure: false, sameSite: "lax", path: "/", maxAge });
      return response;
    }
    return Response.json(
      { error: { code: "SESSION_UNAVAILABLE", message: "게스트 세션 저장소를 사용할 수 없습니다. 다시 시도해 주세요." } },
      { status: 503, headers: { "cache-control": "no-store", "retry-after": "3" } },
    );
  }
}