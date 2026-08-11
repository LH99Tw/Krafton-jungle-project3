import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  fastLaneOfferSchema,
  inputFrameSchema,
  type FastLaneOffer,
  type InputFrame,
  type WorldFrame,
} from "@five-days/protocol";

type RoomBinding = {
  hasSession(sessionId: string, userId: string): boolean;
  onInput(sessionId: string, frame: InputFrame): void;
};

type TokenPayload = {
  r: string;
  s: string;
  u: string;
  e: number;
  n: string;
};

type DatagramWriter = WritableStreamDefaultWriter<Uint8Array>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bindings = new Map<string, RoomBinding>();
const sessions = new Map<string, {
  roomId: string;
  writer: DatagramWriter;
  writeChain: Promise<void>;
  close: () => void;
}>();
const consumedNonces = new Map<string, number>();

let server: { stopServer(): void } | null = null;
let state: "disabled" | "starting" | "ready" | "degraded" = "disabled";
let detail = "feature flag disabled";
let certificateFingerprint: string | null = null;

export function registerFastLaneRoom(roomId: string, binding: RoomBinding): void {
  bindings.set(roomId, binding);
}

export function unregisterFastLaneRoom(roomId: string): void {
  bindings.delete(roomId);
  for (const [sessionId, session] of sessions) {
    if (session.roomId !== roomId) continue;
    session.close();
    sessions.delete(sessionId);
  }
}

export function unbindFastLaneSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  session.close();
}

export function issueFastLaneOffer(roomId: string, sessionId: string, userId: string, now = Date.now()): FastLaneOffer | null {
  if (state !== "ready") return null;
  const publicUrl = process.env.FASTLANE_PUBLIC_URL;
  if (!publicUrl) return null;
  const expiresAt = now + 10_000;
  const payload: TokenPayload = {
    r: roomId,
    s: sessionId,
    u: userId,
    e: expiresAt,
    n: randomBytes(18).toString("base64url"),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(encoded);
  return fastLaneOfferSchema.parse({ url: publicUrl, token: `${encoded}.${signature}`, expiresAt });
}

export function sendFastLaneWorldFrame(sessionId: string, frame: WorldFrame): number | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const bytes = encoder.encode(JSON.stringify({ type: "world.frame", payload: frame }));
  if (bytes.byteLength > 32_768) return null;
  session.writeChain = session.writeChain.then(() => session.writer.write(bytes)).catch(() => {
    session.close();
    if (sessions.get(sessionId) === session) sessions.delete(sessionId);
  });
  return bytes.byteLength;
}

export function fastLaneStatus(): { state: typeof state; detail: string; sessions: number } {
  return { state, detail, sessions: sessions.size };
}

export function markFastLaneDegraded(error: unknown): void {
  state = "degraded";
  detail = error instanceof Error ? error.message : String(error);
}

export async function startFastLaneServer(): Promise<void> {
  if (process.env.FASTLANE_ENABLED !== "true") {
    state = "disabled";
    detail = "feature flag disabled";
    return;
  }
  if (state === "ready" || state === "starting") return;
  server?.stopServer();
  server = null;
  certificateFingerprint = null;
  state = "starting";
  const certPath = requiredEnv("FASTLANE_CERT_PATH");
  const keyPath = requiredEnv("FASTLANE_KEY_PATH");
  requiredSecret();
  const [cert, privKey, module] = await Promise.all([
    readFile(certPath, "utf8"),
    readFile(keyPath, "utf8"),
    import("@fails-components/webtransport"),
  ]);
  const port = envPort("FASTLANE_PORT", 4433);
  const host = process.env.FASTLANE_HOST ?? "0.0.0.0";
  const http3 = new module.Http3Server({
    host,
    port,
    secret: process.env.FASTLANE_QUIC_SECRET ?? randomBytes(32).toString("base64url"),
    cert,
    privKey,
    maxConnections: Number(process.env.MAX_WEBSOCKET_CONNECTIONS ?? 300),
  });
  http3.setRequestCallback(async ({ header }) => {
    const rawPath = pathFromHeader(header);
    const url = new URL(rawPath, "https://fastlane.invalid");
    return {
      status: url.pathname === "/fastlane" ? 200 : 404,
      path: url.pathname,
      header,
    };
  });
  try {
    http3.startServer();
    await http3.ready;
    server = http3;
    certificateFingerprint = fingerprint(cert, privKey);
    state = "ready";
    detail = `udp://${host}:${port}`;
    void acceptSessions(http3).catch((error) => {
      state = "degraded";
      detail = error instanceof Error ? error.message : "session listener failed";
    });
  } catch (error) {
    http3.stopServer();
    server = null;
    certificateFingerprint = null;
    throw error;
  }
}

export async function refreshFastLaneCertificate(): Promise<boolean> {
  if (state !== "ready" || !server) return false;
  const [cert, privKey] = await Promise.all([
    readFile(requiredEnv("FASTLANE_CERT_PATH"), "utf8"),
    readFile(requiredEnv("FASTLANE_KEY_PATH"), "utf8"),
  ]);
  const nextFingerprint = fingerprint(cert, privKey);
  if (nextFingerprint === certificateFingerprint) return false;
  for (const session of sessions.values()) session.close();
  sessions.clear();
  server.stopServer();
  server = null;
  certificateFingerprint = null;
  state = "degraded";
  detail = "restarting for certificate renewal";
  await startFastLaneServer();
  return true;
}

export function stopFastLaneServer(): void {
  for (const session of sessions.values()) session.close();
  sessions.clear();
  server?.stopServer();
  server = null;
  certificateFingerprint = null;
  state = "disabled";
  detail = "server stopped";
}

async function acceptSessions(http3: import("@fails-components/webtransport").Http3Server): Promise<void> {
  const reader = http3.sessionStream("/fastlane").getReader();
  while (state === "ready") {
    const { done, value } = await reader.read();
    if (done) break;
    void bindSession(value).catch(() => value.close({ closeCode: 4003, reason: "FASTLANE_AUTH_FAILED" }));
  }
}

async function bindSession(session: import("@fails-components/webtransport").WebTransportSession): Promise<void> {
  await session.ready;
  const token = tokenFromHeader((session as { header?: unknown }).header);
  const payload = consumeToken(token);
  const binding = bindings.get(payload.r);
  if (!binding?.hasSession(payload.s, payload.u)) throw new Error("room session is no longer active");
  const previous = sessions.get(payload.s);
  previous?.close();
  const writer = session.datagrams.writable.getWriter();
  sessions.set(payload.s, {
    roomId: payload.r,
    writer,
    writeChain: Promise.resolve(),
    close: () => session.close({ closeCode: 0, reason: "session replaced" }),
  });
  session.closed.finally(() => {
    if (sessions.get(payload.s)?.writer === writer) sessions.delete(payload.s);
  }).catch(() => undefined);
  const reader = session.datagrams.readable.getReader();
  while (sessions.get(payload.s)?.writer === writer) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.byteLength > 4096) continue;
    try {
      const message = JSON.parse(decoder.decode(value)) as { type?: unknown; payload?: unknown };
      if (message.type !== "input.frame") continue;
      const frame = inputFrameSchema.parse(message.payload);
      if (binding.hasSession(payload.s, payload.u)) binding.onInput(payload.s, frame);
    } catch {
      // Datagram corruption or stale protocol data is intentionally discarded.
    }
  }
}

function consumeToken(token: string, now = Date.now()): TokenPayload {
  cleanupNonces(now);
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) throw new Error("malformed fast lane token");
  const expected = Buffer.from(sign(encoded));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error("invalid fast lane signature");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as TokenPayload;
  if (!payload.r || !payload.s || !payload.u || !payload.n || payload.e < now || payload.e > now + 15_000) {
    throw new Error("expired fast lane token");
  }
  if (consumedNonces.has(payload.n)) throw new Error("replayed fast lane token");
  consumedNonces.set(payload.n, payload.e);
  return payload;
}

function tokenFromHeader(header: unknown): string {
  const rawPath = pathFromHeader(header);
  const url = new URL(rawPath, "https://fastlane.invalid");
  const token = url.searchParams.get("token");
  if (!token) throw new Error("missing fast lane token");
  return token;
}

function pathFromHeader(header: unknown): string {
  if (!header || typeof header !== "object") throw new Error("missing session headers");
  const candidate = header as Record<string, unknown>;
  const rawPath = candidate[":path"] ?? candidate.path;
  if (typeof rawPath !== "string") throw new Error("missing session path");
  return rawPath;
}

function sign(encoded: string): string {
  return createHmac("sha256", requiredSecret()).update(encoded).digest("base64url");
}

function requiredSecret(): string {
  const secret = process.env.FASTLANE_SECRET;
  if (!secret || secret.length < 32) throw new Error("FASTLANE_SECRET must contain at least 32 characters");
  return secret;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when FASTLANE_ENABLED=true`);
  return value;
}

function envPort(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a valid port`);
  return value;
}

function cleanupNonces(now: number): void {
  for (const [nonce, expiresAt] of consumedNonces) if (expiresAt <= now) consumedNonces.delete(nonce);
}

function fingerprint(cert: string, privKey: string): string {
  return createHash("sha256").update(cert).update("\0").update(privKey).digest("hex");
}
