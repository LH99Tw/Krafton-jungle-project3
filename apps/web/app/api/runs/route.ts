import { listUserRuns } from "@five-days/db/repositories";
import { apiError, getSessionState } from "@/app/auth/session";
import { clientIp, consumeRateLimit, rateLimited, securityNumber } from "@/app/security/request";

export async function GET(request: Request) {
  const decision = consumeRateLimit("runs-ip", clientIp(request), { capacity: securityNumber("READ_API_PER_MINUTE", 60), refillMs: 60_000 });
  if (!decision.allowed) return rateLimited(decision.retryAfterSeconds);
  const session = await getSessionState();
  if (session.status === "unavailable") return apiError("SESSION_UNAVAILABLE", "세션 저장소를 사용할 수 없습니다.", 503);
  if (session.status !== "authenticated") return apiError("AUTH_REQUIRED", "로그인이 필요합니다.", 401);
  const user = session.user;
  try {
    return Response.json({ runs: await listUserRuns(user.id, 10) });
  } catch {
    return Response.json({ runs: [], unavailable: true }, { status: 503 });
  }
}

export async function POST() {
  return apiError("SERVER_AUTHORITY_REQUIRED", "게임 결과는 게임 서버만 저장할 수 있습니다.", 405);
}
