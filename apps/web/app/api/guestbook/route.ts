import { createGuestbookEntry, listGuestbookEntries } from "@five-days/db/repositories";
import { apiError, getSessionUser, validateMutationRequest } from "@/app/auth/session";

export async function GET() {
  try {
    return Response.json({ entries: await listGuestbookEntries(8) });
  } catch {
    return Response.json({ entries: [], unavailable: true }, { status: 503 });
  }
}

export async function POST(request: Request) {
  if (!await validateMutationRequest(request)) return apiError("CSRF_INVALID", "요청을 확인할 수 없습니다.", 403);
  const user = await getSessionUser();
  if (!user) return apiError("AUTH_REQUIRED", "로그인이 필요합니다.", 401);

  let payload: { content?: unknown };
  try {
    payload = await request.json() as { content?: unknown };
  } catch {
    return apiError("INVALID_JSON", "잘못된 요청입니다.", 400);
  }
  const content = typeof payload.content === "string" ? payload.content.trim() : "";
  if (content.length < 2 || content.length > 180) {
    return apiError("INVALID_CONTENT", "메시지는 2~180자로 작성해 주세요.", 400);
  }
  try {
    const entry = await createGuestbookEntry({
      authorId: user.id,
      authorName: user.displayName.slice(0, 60),
      content,
    });
    return Response.json({ entry }, { status: 201 });
  } catch {
    return apiError("GUESTBOOK_UNAVAILABLE", "방명록 저장소를 사용할 수 없습니다.", 503);
  }
}
