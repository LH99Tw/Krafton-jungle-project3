import { getCsrfToken, getSessionState } from "@/app/auth/session";
import { clientIp, consumeRateLimit, rateLimited, securityNumber } from "@/app/security/request";

export async function GET(request: Request) {
  const decision = consumeRateLimit("session-ip", clientIp(request), { capacity: securityNumber("SESSION_PER_MINUTE", 120), refillMs: 60_000 });
  if (!decision.allowed) return rateLimited(decision.retryAfterSeconds);
  const state = await getSessionState();
  if (state.status === "unavailable") {
    return Response.json(
      { error: { code: "SESSION_UNAVAILABLE", message: "세션 저장소에 일시적으로 연결할 수 없습니다." } },
      { status: 503, headers: { "cache-control": "no-store", "retry-after": "3" } },
    );
  }
  const user = state.status === "authenticated" ? state.user : null;
  return Response.json({
    viewer: user ? { userId: user.id, displayName: user.displayName, accountType: user.accountType } : null,
    csrfToken: user ? await getCsrfToken() : null,
  }, { headers: { "cache-control": "no-store" } });
}
