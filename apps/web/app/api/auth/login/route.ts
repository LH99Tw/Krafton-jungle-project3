import {
  encryptSecret,
  encodeOAuthState,
  hashToken,
  pkceChallenge,
  randomToken,
  safeReturnPath,
} from "@five-days/auth";
import { createSession, upsertCognitoUser } from "@five-days/db/repositories";
import { NextResponse } from "next/server";
import { CSRF_COOKIE, sessionCookieName } from "@/app/auth/session";

const OAUTH_COOKIE = "fdm_oauth_state";

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (process.env.NODE_ENV !== "production" && process.env.DEV_AUTH_BYPASS === "true") {
    return createDevelopmentSession(url);
  }
  const state = randomToken();
  const nonce = randomToken();
  const codeVerifier = randomToken(48);
  const returnTo = safeReturnPath(url.searchParams.get("returnTo"));
  const clientId = required("COGNITO_CLIENT_ID");
  const redirectUri = required("COGNITO_REDIRECT_URI");
  const cognitoDomain = required("COGNITO_DOMAIN").replace(/\/$/, "");

  const authorize = new URL(`${cognitoDomain}/oauth2/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", "openid email profile");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("nonce", nonce);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("code_challenge", pkceChallenge(codeVerifier));
  authorize.searchParams.set("identity_provider", "Google");

  const response = NextResponse.redirect(authorize);
  response.cookies.set(OAUTH_COOKIE, encodeOAuthState({
    state,
    nonce,
    codeVerifier,
    returnTo,
    expiresAt: Date.now() + 10 * 60_000,
  }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return response;
}

async function createDevelopmentSession(url: URL) {
  const user = await upsertCognitoUser({
    cognitoSub: "local-development-user",
    email: "developer@localhost",
    displayName: "로컬 용사",
  });
  const sessionToken = randomToken();
  const csrfToken = randomToken();
  await createSession({
    userId: user.id,
    tokenHash: hashToken(sessionToken),
    encryptedRefreshToken: encryptSecret("local-development-refresh-token"),
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
  });
  const response = NextResponse.redirect(new URL(safeReturnPath(url.searchParams.get("returnTo")), url.origin), 303);
  response.cookies.set(sessionCookieName(), sessionToken, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 604_800 });
  response.cookies.set(CSRF_COOKIE, csrfToken, { httpOnly: false, sameSite: "lax", path: "/", maxAge: 604_800 });
  return response;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
