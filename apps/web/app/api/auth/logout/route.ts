import { hashToken } from "@five-days/auth";
import { revokeSession } from "@five-days/db/repositories";
import { NextResponse } from "next/server";
import { CSRF_COOKIE, sessionCookieName, validateMutationRequest } from "@/app/auth/session";

export async function POST(request: Request) {
  if (!await validateMutationRequest(request)) {
    return Response.json({ error: { code: "CSRF_INVALID", message: "요청을 확인할 수 없습니다." } }, { status: 403 });
  }
  const token = readCookie(request.headers.get("cookie") ?? "", sessionCookieName());
  if (token) await revokeSession(hashToken(token));
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(sessionCookieName());
  response.cookies.delete(CSRF_COOKIE);
  return response;
}

function readCookie(header: string, name: string): string | undefined {
  return header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}
