import { signGameTicket } from "@five-days/auth";
import { apiError, getSessionUser, validateMutationRequest } from "@/app/auth/session";

export async function POST(request: Request) {
  if (!await validateMutationRequest(request)) return apiError("CSRF_INVALID", "요청을 확인할 수 없습니다.", 403);
  const user = await getSessionUser();
  if (!user) return apiError("AUTH_REQUIRED", "로그인이 필요합니다.", 401);
  try {
    const { token, expiresAt } = await signGameTicket({ userId: user.id, displayName: user.displayName });
    return Response.json({ token, expiresAt: expiresAt.toISOString() });
  } catch {
    return apiError("TICKET_UNAVAILABLE", "게임 서버 인증을 준비할 수 없습니다.", 503);
  }
}
