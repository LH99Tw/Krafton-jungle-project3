import { hashToken } from "@five-days/auth";
import { revokeSession } from "@five-days/db/repositories";
import { NextResponse } from "next/server";
import { csrfCookieName, sessionCookieName, validateMutationRequest } from "@/app/auth/session";
import { clientIp, consumeRateLimit, rateLimited } from "@/app/security/request";

export async function POST(request: Request) {
  if (!await validateMutationRequest(request)) {
    return Response.json({ error: { code: "CSRF_INVALID", message: "요청을 확인할 수 없습니다." } }, { status: 403 });
  }
  const decision = consumeRateLimit("logout-ip", clientIp(request), { capacity: 20, refillMs: 60_000 });
  if (!decision.allowed) return rateLimited(decision.retryAfterSeconds);
  const token = readCookie(request.headers.get("cookie") ?? "", sessionCookieName());
  if (token) await revokeSession(hashToken(token));
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(sessionCookieName());
  response.cookies.delete(csrfCookieName());
  return response;
}

function readCookie(header: string, name: string): string | undefined {
  return header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}
