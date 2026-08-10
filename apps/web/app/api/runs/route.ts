import { desc, eq } from "drizzle-orm";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { getDb } from "@/db";
import { runResults } from "@/db/schema";

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    const runs = await getDb()
      .select()
      .from(runResults)
      .where(eq(runResults.userId, user.userId))
      .orderBy(desc(runResults.createdAt))
      .limit(10);
    return Response.json({ runs });
  } catch {
    return Response.json({ runs: [], unavailable: true }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  let payload: Record<string, unknown>;
  try {
    payload = await request.json() as Record<string, unknown>;
  } catch {
    return Response.json({ error: "잘못된 요청입니다." }, { status: 400 });
  }

  const stats = typeof payload.stats === "object" && payload.stats ? payload.stats as Record<string, unknown> : {};
  const result = payload.state === "victory" ? "victory" : "defeat";
  const integer = (value: unknown, min = 0, max = 10_000_000) =>
    Math.max(min, Math.min(max, Math.round(typeof value === "number" && Number.isFinite(value) ? value : 0)));

  try {
    const [saved] = await getDb()
      .insert(runResults)
      .values({
        userId: user.userId,
        result,
        reason: typeof payload.reason === "string" ? payload.reason.slice(0, 240) : "원정 종료",
        day: integer(payload.day, 1, 5),
        elapsedSeconds: integer(payload.elapsed, 0, 3600),
        level: integer(payload.level, 1, 99),
        teamPower: integer(payload.teamPower),
        damage: integer(stats.damage),
        bossDamage: integer(stats.bossDamage),
        kills: integer(stats.kills, 0, 100_000),
        deaths: integer(stats.deaths, 0, 10_000),
        structuresBuilt: integer(stats.structuresBuilt, 0, 10_000),
      })
      .returning({ id: runResults.id });
    return Response.json({ run: saved }, { status: 201 });
  } catch {
    return Response.json({ error: "런 결과 저장소를 사용할 수 없습니다." }, { status: 503 });
  }
}

