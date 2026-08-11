import { checkDatabase } from "@five-days/db";

let cached: { expiresAt: number; ready: boolean } = { expiresAt: 0, ready: false };

export async function GET() {
  const now = Date.now();
  if (cached.expiresAt > now) {
    return Response.json(
      { status: cached.ready ? "ready" : "not-ready", service: "web" },
      { status: cached.ready ? 200 : 503, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    await checkDatabase();
    cached = { expiresAt: now + 5_000, ready: true };
    return Response.json({ status: "ready", service: "web" });
  } catch {
    cached = { expiresAt: now + 5_000, ready: false };
    return Response.json({ status: "not-ready", service: "web" }, { status: 503 });
  }
}
