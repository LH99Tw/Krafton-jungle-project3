import {
  encryptSecret,
  hashToken,
  randomToken,
  safeReturnPath,
} from "@five-days/auth";
import { createGuestUser, createSession, upsertCognitoUser } from "@five-days/db/repositories";
import { NextResponse } from "next/server";
import { CSRF_COOKIE, getSessionUser, sessionCookieName } from "@/app/auth/session";

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const requestUrl = new URL(request.url);
  if (origin && origin !== requestUrl.origin) {
    return Response.json({ error: { code: "ORIGIN_INVALID", message: "요청을 확인할 수 없습니다." } }, { status: 403 });
  }
  let body: { displayName?: unknown };
  try {
    body = await request.json() as { displayName?: unknown };
  } catch {
    return Response.json({ error: { code: "INVALID_BODY", message: "이름을 입력해 주세요." } }, { status: 400 });
  }
  const displayName = typeof body.displayName === "string" ? body.displayName.trim().replace(/\s+/g, " ") : "";
  if (displayName.length < 2 || displayName.length > 16 || hasUnsafeCharacter(displayName)) {
    return Response.json({ error: { code: "INVALID_NAME", message: "이름은 2~16자의 안전한 문자로 입력해 주세요." } }, { status: 400 });
  }
  const user = await createGuestUser({ displayName });
  const sessionToken = randomToken();
  const csrfToken = randomToken();
  const maxAge = 24 * 60 * 60;
  await createSession({
    userId: user.id,
    tokenHash: hashToken(sessionToken),
    encryptedRefreshToken: encryptSecret("guest-session"),
    expiresAt: new Date(Date.now() + maxAge * 1000),
  });
  const response = NextResponse.json({
    viewer: { userId: user.id, displayName: user.displayName, email: user.email, accountType: "guest" as const },
    csrfToken,
  });
  response.cookies.set(sessionCookieName(), sessionToken, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge });
  response.cookies.set(CSRF_COOKIE, csrfToken, { httpOnly: false, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge });
  return response;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnTo = safeReturnPath(url.searchParams.get("returnTo"));
  const existing = await getSessionUser();
  if (existing) return NextResponse.redirect(new URL(returnTo, url.origin), 303);

  const enabled = process.env.PUBLIC_PLAYTEST_ENABLED === "true" || process.env.NODE_ENV !== "production";
  if (!enabled) return NextResponse.redirect(new URL(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`, url.origin), 303);

  const guestId = crypto.randomUUID();
  const guestTag = guestId.slice(0, 6).toUpperCase();
  const user = await upsertCognitoUser({
    cognitoSub: `guest:${guestId}`,
    email: `guest+${guestId}@playtest.invalid`,
    displayName: `게스트-${guestTag}`,
  });
  const sessionToken = randomToken();
  const csrfToken = randomToken();
  const maxAge = 86_400;
  await createSession({
    userId: user.id,
    tokenHash: hashToken(sessionToken),
    encryptedRefreshToken: encryptSecret(`guest:${guestId}`),
    expiresAt: new Date(Date.now() + maxAge * 1000),
  });

  const response = NextResponse.redirect(new URL(returnTo, url.origin), 303);
  const secure = process.env.NODE_ENV === "production";
  response.cookies.set(sessionCookieName(), sessionToken, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge,
  });
  response.cookies.set(CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge,
  });
  return response;
}

function hasUnsafeCharacter(value: string): boolean {
  return value.includes("<") || value.includes(">") || [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}
