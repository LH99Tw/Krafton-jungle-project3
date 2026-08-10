import { listUserRuns } from "@five-days/db/repositories";
import { apiError, getSessionUser } from "@/app/auth/session";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return apiError("AUTH_REQUIRED", "로그인이 필요합니다.", 401);
  try {
    return Response.json({ runs: await listUserRuns(user.id, 10) });
  } catch {
    return Response.json({ runs: [], unavailable: true }, { status: 503 });
  }
}

export async function POST() {
  return apiError("SERVER_AUTHORITY_REQUIRED", "게임 결과는 게임 서버만 저장할 수 있습니다.", 405);
}
