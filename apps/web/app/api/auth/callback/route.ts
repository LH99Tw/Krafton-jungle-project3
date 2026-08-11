import {
  decodeOAuthState,
  hashToken,
  randomToken,
  safeEqual,
  verifyCognitoIdToken,
} from "@five-days/auth";
import { createSession, upsertCognitoUser } from "@five-days/db/repositories";
import { NextResponse } from "next/server";
import { csrfCookieName, expireAuthCookie, oauthCookieName, sessionCookieName } from "@/app/auth/session";
import { clientIp, consumeRateLimit, rateLimited } from "@/app/security/request";

export async function GET(request: Request) {
  const decision = consumeRateLimit("auth-callback-ip", clientIp(request), { capacity: 20, refillMs: 10 * 60_000 });
  if (!decision.allowed) return rateLimited(decision.retryAfterSeconds);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const receivedState = url.searchParams.get("state");
  const cookieHeader = request.headers.get("cookie") ?? "";
  const encodedState = readCookie(cookieHeader, oauthCookieName());
  if (!code || !receivedState || !encodedState) return failure(url, "missing_oauth_response");

  try {
    const oauth = decodeOAuthState(encodedState);
    if (!safeEqual(oauth.state, receivedState)) return failure(url, "invalid_oauth_state");

    const tokenResponse = await exchangeCode(code, oauth.codeVerifier);
    const identity = await verifyCognitoIdToken({
      token: tokenResponse.id_token,
      issuer: required("COGNITO_ISSUER"),
      clientId: required("COGNITO_CLIENT_ID"),
      nonce: oauth.nonce,
    });
    const user = await upsertCognitoUser({
      cognitoSub: identity.sub,
      email: identity.email,
      displayName: identity.displayName,
    });
    const sessionToken = randomToken();
    const csrfToken = randomToken();
    const sessionDays = 7;
    await createSession({
      userId: user.id,
      tokenHash: hashToken(sessionToken),
      encryptedRefreshToken: null,
      expiresAt: new Date(Date.now() + sessionDays * 86_400_000),
    });

    const response = NextResponse.redirect(new URL(oauth.returnTo, required("APP_ORIGIN")), 303);
    expireAuthCookie(response, oauthCookieName(), true);
    response.cookies.set(sessionCookieName(), sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: sessionDays * 86_400,
    });
    response.cookies.set(csrfCookieName(), csrfToken, {
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: sessionDays * 86_400,
    });
    return response;
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "oauth.callback.failed", error: error instanceof Error ? error.message : "unknown" }));
    return failure(url, "oauth_callback_failed");
  }
}

async function exchangeCode(code: string, codeVerifier: string) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: required("COGNITO_CLIENT_ID"),
    code,
    redirect_uri: required("COGNITO_REDIRECT_URI"),
    code_verifier: codeVerifier,
  });
  const clientSecret = process.env.COGNITO_CLIENT_SECRET;
  const response = await fetch(`${required("COGNITO_DOMAIN").replace(/\/$/, "")}/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(clientSecret ? { authorization: `Basic ${Buffer.from(`${required("COGNITO_CLIENT_ID")}:${clientSecret}`).toString("base64")}` } : {}),
    },
    body,
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Cognito token exchange failed: ${response.status}`);
  const value = await response.json() as { id_token?: string };
  if (!value.id_token) throw new Error("Cognito token response is missing id_token");
  return { id_token: value.id_token };
}

function readCookie(header: string, name: string): string | undefined {
  return header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function failure(requestUrl: URL, code: string) {
  const response = NextResponse.redirect(new URL(`/?authError=${encodeURIComponent(code)}`, required("APP_ORIGIN")), 303);
  expireAuthCookie(response, oauthCookieName(), true);
  return response;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
