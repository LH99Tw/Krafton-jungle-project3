import { createServer } from "node:http";
import express from "express";
import { matchMaker, Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { checkDatabase } from "@five-days/db";
import { cleanupExpiredSecurityRecords } from "@five-days/db/repositories";
import { PARTY_ROOM, PartyRoom } from "./party-room";
import { GameLobbyRoom, LOBBY_ROOM } from "./lobby-room";
import { GlobalChatRoom, GLOBAL_CHAT_ROOM } from "./global-chat-room";
import { configuredOrigins, numericEnv, take, validateGameRuntimeEnvironment } from "./security";
import {
  fastLaneStatus,
  markFastLaneDegraded,
  refreshFastLaneCertificate,
  startFastLaneServer,
  stopFastLaneServer,
} from "./fast-lane";
import { realtimeMetricsSnapshot } from "./realtime-metrics";

validateGameRuntimeEnvironment();
const cleanupTimer = setInterval(() => void cleanupExpiredSecurityRecords().catch(() => undefined), 10 * 60_000);
cleanupTimer.unref();
const port = Number(process.env.PORT ?? 2567);
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
const httpServer = createServer(app);
httpServer.maxConnections = numericEnv("MAX_HTTP_CONNECTIONS", 350, 10, 10_000);
httpServer.headersTimeout = 10_000;
httpServer.requestTimeout = 15_000;
httpServer.keepAliveTimeout = 5_000;
httpServer.maxHeadersCount = 64;
const gameServer = new Server({ transport: new WebSocketTransport({ server: httpServer, pingInterval: 10_000, maxPayload: 4096 }) });

gameServer.define(PARTY_ROOM, PartyRoom).filterBy(["partyMode", "sessionMode", "difficulty"]);
gameServer.define(LOBBY_ROOM, GameLobbyRoom);
gameServer.define(GLOBAL_CHAT_ROOM, GlobalChatRoom);

let lobbyCache: { expiresAt: number; value: unknown[] } = { expiresAt: 0, value: [] };

app.get("/lobbies", async (request, response) => {
  const origin = request.headers.origin;
  if (origin && configuredOrigins().has(origin)) response.setHeader("access-control-allow-origin", origin);
  if (!take(`lobbies:${request.ip}`, numericEnv("LOBBY_LIST_PER_MINUTE", 30, 1, 10_000), 60_000)) {
    response.setHeader("retry-after", "2");
    return response.status(429).json({ error: { code: "RATE_LIMITED", message: "요청이 너무 많습니다." } });
  }
  const now = Date.now();
  if (lobbyCache.expiresAt > now) return response.json(lobbyCache.value);
  const rooms = (await matchMaker.query({ name: LOBBY_ROOM, unlisted: false })).slice(0, 50);
  const value = rooms.map((room) => ({
    roomId: room.roomId,
    roomName: room.metadata?.roomName ?? "이름 없는 원정대",
    clients: room.metadata?.partySize ?? room.clients,
    maxClients: 3,
    phase: room.metadata?.phase ?? "waiting",
    sessionMode: room.metadata?.sessionMode ?? "prototype",
    difficulty: room.metadata?.difficulty ?? "normal",
  }));
  lobbyCache = { expiresAt: now + 1_000, value };
  return response.json(value);
});

app.get("/health/live", (_request, response) => {
  response.json({
    status: "ok",
    service: "game-server",
    fastLane: fastLaneStatus(),
    realtime: realtimeMetricsSnapshot(),
  });
});
let readinessCache: { expiresAt: number; ready: boolean } = { expiresAt: 0, ready: false };
app.get("/health/ready", async (_request, response) => {
  const now = Date.now();
  if (readinessCache.expiresAt > now) {
    return response.status(readinessCache.ready ? 200 : 503).json({ status: readinessCache.ready ? "ready" : "not-ready", service: "game-server" });
  }
  try {
    await checkDatabase();
    readinessCache = { expiresAt: now + 5_000, ready: true };
    response.json({ status: "ready", service: "game-server" });
  } catch {
    readinessCache = { expiresAt: now + 5_000, ready: false };
    response.status(503).json({ status: "not-ready", service: "game-server" });
  }
});

await gameServer.listen(port);
let fastLaneStartPending = false;
async function maintainFastLane(): Promise<void> {
  if (process.env.FASTLANE_ENABLED !== "true" || fastLaneStartPending) return;
  fastLaneStartPending = true;
  try {
    if (fastLaneStatus().state === "ready") {
      if (await refreshFastLaneCertificate()) {
        console.log(JSON.stringify({ level: "info", event: "fast-lane.certificate-reloaded" }));
      }
    } else {
      await startFastLaneServer();
      console.log(JSON.stringify({ level: "info", event: "fast-lane.ready", fastLane: fastLaneStatus() }));
    }
  } catch (error) {
    if (fastLaneStatus().state !== "ready") markFastLaneDegraded(error);
    console.error(JSON.stringify({
      level: "error",
      event: fastLaneStatus().state === "ready" ? "fast-lane.certificate-reload-failed" : "fast-lane.degraded",
      message: error instanceof Error ? error.message : String(error),
    }));
  } finally {
    fastLaneStartPending = false;
  }
}
await maintainFastLane();
const fastLaneMaintenanceTimer = setInterval(
  () => void maintainFastLane(),
  numericEnv("FASTLANE_MAINTENANCE_MS", 10_000, 1_000, 300_000),
);
fastLaneMaintenanceTimer.unref();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  clearInterval(fastLaneMaintenanceTimer);
  stopFastLaneServer();
});
console.log(JSON.stringify({ level: "info", event: "game-server.started", port, fastLane: fastLaneStatus() }));
