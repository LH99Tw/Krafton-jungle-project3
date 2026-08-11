import { hashToken, safeEqual } from "@five-days/auth";
import { findSessionUser, type UserRecord } from "@five-days/db/repositories";
import { cookies, headers } from "next/headers";
import {
  CSRF_COOKIE,
  csrfCookieName,
  sessionCookieName,
} from "./cookies";

export {
  CSRF_COOKIE,
  csrfCookieName,
  expireAuthCookie,
  oauthCookieName,
  sessionCookieName,
} from "./cookies";
export const SessionUnavailable = Symbol("SessionUnavailable");

export type SessionUser = UserRecord & { accountType: "member" | "guest" };

export type SessionState =
  | { status: "authenticated"; user: SessionUser }
  | { status: "unauthenticated" }
  | { status: "unavailable" };

export async function getSessionState(): Promise<SessionState> {
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName())?.value;
  if (!token) return { status: "unauthenticated" };
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { status: "unauthenticated" };
  try {
    const user = await findSessionUser(hashToken(token));
    return user
      ? { status: "authenticated", user: { ...user, accountType: user.cognitoSub.startsWith("guest:") ? "guest" : "member" } }
      : { status: "unauthenticated" };
  } catch {
    if (process.env.NODE_ENV !== "production") {
      return {
        status: "authenticated",
        user: { id: "dev-guest-user", displayName: "마법사", accountType: "guest", cognitoSub: "guest:dev-guest-user" } as SessionUser,
      };
    }
    return { status: "unavailable" };
  }
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const state = await getSessionState();
  if (state.status === "unavailable") throw SessionUnavailable;
  return state.status === "authenticated" ? state.user : null;
}

export async function getCsrfToken(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(csrfCookieName())?.value
    ?? (csrfCookieName() !== CSRF_COOKIE ? cookieStore.get(CSRF_COOKIE)?.value : undefined)
    ?? null;
}

export async function validateMutationRequest(request: Request): Promise<boolean> {
  const cookieToken = await getCsrfToken();
  const headerToken = request.headers.get("x-csrf-token");
  if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken)) return false;

  const origin = request.headers.get("origin");
  if (!origin) return process.env.NODE_ENV !== "production";
  const allowed = new Set(
    (process.env.ALLOWED_ORIGINS ?? process.env.APP_ORIGIN ?? "http://localhost:3000")
      .split(",").map((value) => value.trim()).filter(Boolean),
  );
  return allowed.has(origin);
}

export async function requestId(): Promise<string> {
  const supplied = (await headers()).get("x-request-id");
  return supplied && /^[a-zA-Z0-9._:-]{1,64}$/.test(supplied) ? supplied : crypto.randomUUID();
}

export async function apiError(code: string, message: string, status: number): Promise<Response> {
  return Response.json({ error: { code, message, requestId: await requestId() } }, { status });
}