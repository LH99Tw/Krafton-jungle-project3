import { hashToken, safeEqual } from "@five-days/auth";
import { findSessionUser, type UserRecord } from "@five-days/db/repositories";
import { cookies, headers } from "next/headers";

export const CSRF_COOKIE = "fdm_csrf";

export type SessionUser = UserRecord & { accountType: "member" | "guest" };

export function sessionCookieName(): string {
  return process.env.NODE_ENV === "production" ? "__Host-fdm_session" : "fdm_session";
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName())?.value;
  if (!token) return null;
  try {
    const user = await findSessionUser(hashToken(token));
    return user ? { ...user, accountType: user.cognitoSub.startsWith("guest:") ? "guest" : "member" } : null;
  } catch {
    return null;
  }
}

export async function getCsrfToken(): Promise<string | null> {
  return (await cookies()).get(CSRF_COOKIE)?.value ?? null;
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
  return (await headers()).get("x-request-id") ?? crypto.randomUUID();
}

export async function apiError(code: string, message: string, status: number): Promise<Response> {
  return Response.json({ error: { code, message, requestId: await requestId() } }, { status });
}
