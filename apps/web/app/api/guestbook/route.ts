import { desc } from "drizzle-orm";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { getDb } from "@/db";
import { guestbookEntries } from "@/db/schema";

export async function GET() {
  try {
    const entries = await getDb()
      .select({
        id: guestbookEntries.id,
        authorName: guestbookEntries.authorName,
        content: guestbookEntries.content,
        createdAt: guestbookEntries.createdAt,
      })
      .from(guestbookEntries)
      .orderBy(desc(guestbookEntries.createdAt), desc(guestbookEntries.id))
      .limit(8);
    return Response.json({ entries });
  } catch {
    return Response.json({ entries: [], unavailable: true }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });

  let payload: { content?: unknown };
  try {
    payload = await request.json() as { content?: unknown };
  } catch {
    return Response.json({ error: "잘못된 요청입니다." }, { status: 400 });
  }

  const content = typeof payload.content === "string" ? payload.content.trim() : "";
  if (content.length < 2 || content.length > 180) {
    return Response.json({ error: "메시지는 2~180자로 작성해 주세요." }, { status: 400 });
  }

  try {
    const [entry] = await getDb()
      .insert(guestbookEntries)
      .values({ authorId: user.userId, authorName: user.displayName.slice(0, 60), content })
      .returning({
        id: guestbookEntries.id,
        authorName: guestbookEntries.authorName,
        content: guestbookEntries.content,
        createdAt: guestbookEntries.createdAt,
      });
    return Response.json({ entry }, { status: 201 });
  } catch {
    return Response.json({ error: "방명록 저장소를 사용할 수 없습니다." }, { status: 503 });
  }
}

