import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  createRemoteJWKSet,
  exportJWK,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
  type JWTPayload,
} from "jose";
import { PROTOCOL_VERSION as GAME_PROTOCOL_VERSION } from "@five-days/protocol";

export const PROTOCOL_VERSION = GAME_PROTOCOL_VERSION;
export const GAME_TICKET_ISSUER = "five-days-web";
export const GAME_TICKET_AUDIENCE = "five-days-game-server";

export type OAuthState = {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  expiresAt: number;
};

export type GameTicketClaims = JWTPayload & {
  sub: string;
  jti: string;
  scope: "room:join";
  protocolVersion: number;
  displayName: string;
};

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function encryptionKey(value = process.env.AUTH_SESSION_ENCRYPTION_KEY): Buffer {
  if (!value) throw new Error("AUTH_SESSION_ENCRYPTION_KEY is required");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("AUTH_SESSION_ENCRYPTION_KEY must be 32 bytes encoded as base64");
  return key;
}

export function encryptSecret(plainText: string, keyValue?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(keyValue), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptSecret(value: string, keyValue?: string): string {
  const [ivValue, tagValue, encryptedValue] = value.split(".");
  if (!ivValue || !tagValue || !encryptedValue) throw new Error("Invalid encrypted value");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(keyValue), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function encodeOAuthState(value: OAuthState): string {
  return encryptSecret(JSON.stringify(value));
}

export function decodeOAuthState(value: string): OAuthState {
  const parsed = JSON.parse(decryptSecret(value)) as OAuthState;
  if (!parsed.state || !parsed.nonce || !parsed.codeVerifier || parsed.expiresAt < Date.now()) {
    throw new Error("OAuth state expired or malformed");
  }
  return parsed;
}

export function safeReturnPath(value: string | null | undefined): string {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, "https://app.local");
    if (url.origin !== "https://app.local") return "/";
    if (["/api/auth/login", "/api/auth/callback", "/api/auth/logout", "/api/auth/guest"].includes(url.pathname)) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

export async function signGameTicket(input: {
  userId: string;
  displayName: string;
  privateKeyPem?: string;
  keyId?: string;
  expiresInSeconds?: number;
}): Promise<{ token: string; expiresAt: Date }> {
  const privateKeyPem = input.privateKeyPem ?? readPem("GAME_TICKET_PRIVATE_KEY", "GAME_TICKET_PRIVATE_KEY_BASE64");
  if (!privateKeyPem) throw new Error("GAME_TICKET_PRIVATE_KEY is required");
  const key = await importPKCS8(privateKeyPem, "RS256");
  const now = Math.floor(Date.now() / 1000);
  const expiresAtSeconds = now + (input.expiresInSeconds ?? 90);
  const token = await new SignJWT({
    scope: "room:join",
    protocolVersion: PROTOCOL_VERSION,
    displayName: input.displayName,
  })
    .setProtectedHeader({ alg: "RS256", kid: input.keyId ?? process.env.GAME_TICKET_ACTIVE_KID ?? "v1" })
    .setIssuer(GAME_TICKET_ISSUER)
    .setAudience(GAME_TICKET_AUDIENCE)
    .setSubject(input.userId)
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(expiresAtSeconds)
    .sign(key);
  return { token, expiresAt: new Date(expiresAtSeconds * 1000) };
}

export async function verifyGameTicket(token: string, publicKeyPem?: string): Promise<GameTicketClaims> {
  const keyPem = publicKeyPem ?? readPem("GAME_TICKET_PUBLIC_KEY", "GAME_TICKET_PUBLIC_KEY_BASE64");
  if (!keyPem) throw new Error("GAME_TICKET_PUBLIC_KEY is required");
  const key = await importSPKI(keyPem, "RS256");
  const { payload } = await jwtVerify(token, key, {
    issuer: GAME_TICKET_ISSUER,
    audience: GAME_TICKET_AUDIENCE,
    algorithms: ["RS256"],
  });
  if (
    typeof payload.sub !== "string" ||
    typeof payload.jti !== "string" ||
    payload.scope !== "room:join" ||
    payload.protocolVersion !== PROTOCOL_VERSION ||
    typeof payload.displayName !== "string"
  ) throw new Error("Invalid game ticket claims");
  return payload as GameTicketClaims;
}

function readPem(textName: string, base64Name: string): string | undefined {
  const plain = process.env[textName]?.replace(/\\n/g, "\n");
  if (plain) return plain;
  const encoded = process.env[base64Name];
  return encoded ? Buffer.from(encoded, "base64").toString("utf8") : undefined;
}

export async function verifyCognitoIdToken(input: {
  token: string;
  issuer: string;
  clientId: string;
  nonce: string;
}) {
  const jwks = createRemoteJWKSet(new URL(`${input.issuer}/.well-known/jwks.json`));
  const { payload } = await jwtVerify(input.token, jwks, {
    issuer: input.issuer,
    audience: input.clientId,
  });
  if (payload.nonce !== input.nonce) throw new Error("Invalid OAuth nonce");
  if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
    throw new Error("Cognito token is missing required claims");
  }
  return {
    sub: payload.sub,
    email: payload.email,
    displayName: typeof payload.name === "string" ? payload.name : payload.email,
  };
}

export async function publicJwkFromPem(publicKeyPem: string) {
  return exportJWK(await importSPKI(publicKeyPem, "RS256"));
}
