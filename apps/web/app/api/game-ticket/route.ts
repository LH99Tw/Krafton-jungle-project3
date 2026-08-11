import { signGameTicket } from "@five-days/auth";
import { registerGameTicket } from "@five-days/db/repositories";
import { gameTicketRoomSchema } from "@five-days/protocol";
import { apiError, getSessionState, validateMutationRequest } from "@/app/auth/session";
import { clientIp, consumeRateLimit, payloadError, rateLimited, readJsonLimited, securityNumber } from "@/app/security/request";

export async function POST(request: Request) {
  if (!await validateMutationRequest(request)) return apiError("CSRF_INVALID", "요청 오리진을 확인할 수 없습니다.", 403);
  const ipDecision = consumeRateLimit("game-ticket-ip", clientIp(request), { capacity: securityNumber("GAME_TICKET_IP_PER_MINUTE", 60), refillMs: 60_000 });
  if (!ipDecision.allowed) return rateLimited(ipDecision.retryAfterSeconds);
  const session = await getSessionState();
  if (session.status === "unavailable") return apiError("SESSION_UNAVAILABLE", "세션 저장소를 사용할 수 없습니다.", 503);
  if (session.status !== "authenticated") return apiError("AUTH_REQUIRED", "로그인이 필요합니다.", 401);
  const user = session.user;
  for (const decision of [
    consumeRateLimit("game-ticket-user", user.id, { capacity: securityNumber("GAME_TICKET_USER_PER_MINUTE", 30), refillMs: 60_000 }),
  ]) {
    if (!decision.allowed) return rateLimited(decision.retryAfterSeconds);
  }
  try {
    const input = await readJsonLimited<{ room?: unknown }>(request, 1024);
    const room = gameTicketRoomSchema.safeParse(input.room);
    if (!room.success) return apiError("INVALID_TICKET_PURPOSE", "접속 목적을 확인할 수 없습니다.", 400);
    const { token, expiresAt, jti } = await signGameTicket({ userId: user.id, displayName: user.displayName, room: room.data });
    try {
      await registerGameTicket({ jti, userId: user.id, room: room.data, expiresAt });
    } catch (dbErr) {
      if (process.env.NODE_ENV === "production") throw dbErr;
    }
    return Response.json({ token, expiresAt: expiresAt.toISOString() });
  } catch (error) {
    const response = payloadError(error);
    if (response) return response;
    return apiError("TICKET_UNAVAILABLE", "게임 서버 인증을 준비할 수 없습니다.", 503);
  }
}