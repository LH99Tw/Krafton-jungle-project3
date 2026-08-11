import { ServerError, type AuthContext, type Client } from "@colyseus/core";
import { createPublicKey } from "node:crypto";
import { verifyGameTicket, type GameTicketClaims } from "@five-days/auth";
import { consumeGameTicketNonce } from "@five-days/db/repositories";
import { PROTOCOL_VERSION, type GameTicketRoom } from "@five-days/protocol";

type Bucket = { tokens: number; updatedAt: number; lastSeenAt: number };
const buckets = new Map<string, Bucket>();
const activeConnections = new Map<string, Client>();
const violations = new Map<string, { startedAt: number; count: number }>();
let lastCleanupAt = 0;

export function validateGameRuntimeEnvironment(): void {
  const port = Number(process.env.PORT ?? 2567);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port");
  const configuredProtocol = process.env.PROTOCOL_VERSION;
  if (configuredProtocol && Number(configuredProtocol) !== PROTOCOL_VERSION) {
    throw new Error(`PROTOCOL_VERSION must be ${PROTOCOL_VERSION}`);
  }
  if (process.env.NODE_ENV !== "production") return;
  const origins = configuredOrigins();
  if (origins.size === 0 || [...origins].some((origin) => !origin.startsWith("https://"))) {
    throw new Error("Production ALLOWED_ORIGINS must contain HTTPS origins only");
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required in production");
  const publicKey = process.env.GAME_TICKET_PUBLIC_KEY?.replace(/\\n/g, "\n")
    ?? (process.env.GAME_TICKET_PUBLIC_KEY_BASE64 ? Buffer.from(process.env.GAME_TICKET_PUBLIC_KEY_BASE64, "base64").toString("utf8") : "");
  if (!publicKey) {
    throw new Error("GAME_TICKET_PUBLIC_KEY is required in production");
  }
  createPublicKey(publicKey);
}

export async function authorizeGameConnection(
  token: string,
  context: AuthContext,
  room: GameTicketRoom,
  consume: typeof consumeGameTicketNonce = consumeGameTicketNonce,
): Promise<GameTicketClaims> {
  validateOrigin(context.headers.origin);
  const ip = clientIp(context);
  const wsLimit = numericEnv("WS_AUTH_PER_MINUTE", 20, 1, 10_000);
  if (!take(`ws-ip:${ip}`, wsLimit, 60_000)) throw new ServerError(429, "접속 요청이 너무 많습니다.");
  if (!token) throw new ServerError(401, "게임 접속 티켓이 필요합니다.");
  const claims = await verifyGameTicket(token);
  if (claims.room !== room) throw new ServerError(403, "접속 목적이 일치하지 않습니다.");
  if (!take(`ws-user:${claims.sub}`, wsLimit, 60_000)) throw new ServerError(429, "접속 요청이 너무 많습니다.");
  if (activeConnections.size >= numericEnv("MAX_WEBSOCKET_CONNECTIONS", 300, 10, 10_000)) {
    throw new ServerError(503, "게임 서버 접속 한도에 도달했습니다.");
  }
  if (!await consume({ jti: claims.jti, userId: claims.sub, room })) {
    throw new ServerError(401, "이미 사용되었거나 만료된 접속 티켓입니다.");
  }
  return claims;
}

export function registerConnection(room: GameTicketRoom, userId: string, client: Client): void {
  const key = `${room}:${userId}`;
  const previous = activeConnections.get(key);
  activeConnections.set(key, client);
  if (previous && previous !== client) previous.leave(4009, "DUPLICATE_LOGIN");
}

export function hasRegisteredConnection(room: GameTicketRoom, userId: string, excluding: Client): boolean {
  const current = activeConnections.get(`${room}:${userId}`);
  return Boolean(current && current !== excluding);
}

export function unregisterConnection(room: GameTicketRoom, userId: string, client: Client): void {
  const key = `${room}:${userId}`;
  if (activeConnections.get(key) === client) activeConnections.delete(key);
  violations.delete(client.sessionId);
}

export function recordProtocolViolation(client: Client, code: string): void {
  const now = Date.now();
  const current = violations.get(client.sessionId);
  const next = !current || now - current.startedAt >= 10_000
    ? { startedAt: now, count: 1 }
    : { startedAt: current.startedAt, count: current.count + 1 };
  violations.set(client.sessionId, next);
  if (next.count >= 5) client.leave(4008, code);
}

export function take(key: string, capacity: number, refillMs: number, now = Date.now()): boolean {
  cleanup(now);
  const refillPerMs = capacity / refillMs;
  const current = buckets.get(key);
  const tokens = current
    ? Math.min(capacity, current.tokens + Math.max(0, now - current.updatedAt) * refillPerMs)
    : capacity;
  buckets.set(key, { tokens: Math.max(0, tokens - 1), updatedAt: now, lastSeenAt: now });
  return tokens >= 1;
}

export function configuredOrigins(): Set<string> {
  return new Set((process.env.ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
}

function validateOrigin(origin: string | undefined): void {
  if (!origin && process.env.NODE_ENV !== "production") return;
  if (!origin || !configuredOrigins().has(origin)) throw new ServerError(403, "허용되지 않은 Origin입니다.");
}

function clientIp(context: AuthContext): string {
  const raw = context.headers["x-forwarded-for"];
  const value = Array.isArray(raw) ? raw.at(-1) : raw;
  const candidate = value?.split(",").at(-1)?.trim() ?? "unknown";
  return candidate.length <= 64 && /^[0-9a-f:.]+$/iu.test(candidate) ? candidate.toLowerCase() : "unknown";
}

export function numericEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.trunc(value))) : fallback;
}

function cleanup(now: number): void {
  if (now - lastCleanupAt < 60_000 && buckets.size <= 10_000) return;
  lastCleanupAt = now;
  const staleBefore = now - 2 * 86_400_000;
  for (const [key, bucket] of buckets) if (bucket.lastSeenAt < staleBefore) buckets.delete(key);
  if (buckets.size > 10_000) {
    const oldest = [...buckets.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt).slice(0, buckets.size - 10_000);
    for (const [key] of oldest) buckets.delete(key);
  }
}
