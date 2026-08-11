import { createPrivateKey } from "node:crypto";
import { PROTOCOL_VERSION } from "@five-days/protocol";

export function validateProductionWebEnvironment(): void {
  const appOrigin = requiredUrl("APP_ORIGIN");
  if (appOrigin.protocol !== "https:") throw new Error("Production APP_ORIGIN must use HTTPS");
  const gameUrl = requiredUrl("GAME_SERVER_PUBLIC_URL");
  if (gameUrl.protocol !== "wss:") throw new Error("Production GAME_SERVER_PUBLIC_URL must use WSS");
  const allowedOrigins = required("ALLOWED_ORIGINS").split(",").map((value) => value.trim()).filter(Boolean);
  for (const origin of allowedOrigins) {
    if (new URL(origin).protocol !== "https:") throw new Error("Production ALLOWED_ORIGINS must use HTTPS");
  }
  if (!allowedOrigins.includes(appOrigin.origin)) throw new Error("ALLOWED_ORIGINS must include APP_ORIGIN");
  if (process.env.DEV_AUTH_BYPASS === "true") throw new Error("DEV_AUTH_BYPASS must be false in production");
  const key = Buffer.from(required("AUTH_SESSION_ENCRYPTION_KEY"), "base64");
  if (key.length !== 32) throw new Error("AUTH_SESSION_ENCRYPTION_KEY must decode to 32 bytes");
  required("DATABASE_URL");
  const privateKey = Buffer.from(required("GAME_TICKET_PRIVATE_KEY_BASE64"), "base64").toString("utf8");
  createPrivateKey(privateKey);
  required("COGNITO_CLIENT_ID");
  if (requiredUrl("COGNITO_ISSUER").protocol !== "https:") throw new Error("COGNITO_ISSUER must use HTTPS");
  if (requiredUrl("COGNITO_DOMAIN").protocol !== "https:") throw new Error("COGNITO_DOMAIN must use HTTPS");
  const redirect = requiredUrl("COGNITO_REDIRECT_URI");
  if (redirect.origin !== appOrigin.origin || redirect.pathname !== "/api/auth/callback") {
    throw new Error("COGNITO_REDIRECT_URI must use APP_ORIGIN and the auth callback path");
  }
  if (Number(required("PROTOCOL_VERSION")) !== PROTOCOL_VERSION) {
    throw new Error(`PROTOCOL_VERSION must be ${PROTOCOL_VERSION}`);
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required in production`);
  return value;
}

function requiredUrl(name: string): URL {
  return new URL(required(name));
}
