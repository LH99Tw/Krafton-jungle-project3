import { checkDatabase } from "@five-days/db";

export async function GET() {
  try {
    await checkDatabase();
    return Response.json({ status: "ready", service: "web" });
  } catch {
    return Response.json({ status: "not-ready", service: "web" }, { status: 503 });
  }
}
