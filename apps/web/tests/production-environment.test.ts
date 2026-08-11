import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import test from "node:test";
import { validateProductionWebEnvironment } from "../instrumentation-node";

test("production refuses a missing or weak guestbook administrator key", () => {
  const mutableEnv = process.env as Record<string, string | undefined>;
  const original = { ...process.env };
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  Object.assign(mutableEnv, {
    NODE_ENV: "production",
    APP_ORIGIN: "https://web.example.com",
    GAME_SERVER_PUBLIC_URL: "wss://game.example.com",
    ALLOWED_ORIGINS: "https://web.example.com",
    DEV_AUTH_BYPASS: "false",
    AUTH_SESSION_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    DATABASE_URL: "postgresql://app:secret@postgres:5432/app",
    GAME_TICKET_PRIVATE_KEY_BASE64: Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64"),
    COGNITO_CLIENT_ID: "client-id",
    COGNITO_ISSUER: "https://cognito-idp.example.com/pool",
    COGNITO_DOMAIN: "https://auth.example.com",
    COGNITO_REDIRECT_URI: "https://web.example.com/api/auth/callback",
    PROTOCOL_VERSION: "4",
  });
  delete mutableEnv.GUESTBOOK_ADMIN_DELETE_KEY;
  try {
    assert.throws(() => validateProductionWebEnvironment(), /GUESTBOOK_ADMIN_DELETE_KEY/);
    mutableEnv.GUESTBOOK_ADMIN_DELETE_KEY = "x".repeat(31);
    assert.throws(() => validateProductionWebEnvironment(), /at least 32 characters/);
    mutableEnv.GUESTBOOK_ADMIN_DELETE_KEY = randomBytes(48).toString("base64url");
    assert.doesNotThrow(() => validateProductionWebEnvironment());
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) delete mutableEnv[key];
    }
    Object.assign(mutableEnv, original);
  }
});
