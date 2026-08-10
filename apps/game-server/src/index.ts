import { createServer } from "node:http";
import express from "express";
import { matchMaker, Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { checkDatabase } from "@five-days/db";
import { PARTY_ROOM, PartyRoom } from "./party-room";
import { GameLobbyRoom, LOBBY_ROOM } from "./lobby-room";

const port = Number(process.env.PORT ?? 2567);
const app = express();
const httpServer = createServer(app);
const gameServer = new Server({ transport: new WebSocketTransport({ server: httpServer, pingInterval: 10_000, maxPayload: 4096 }) });

gameServer.define(PARTY_ROOM, PartyRoom);
gameServer.define(LOBBY_ROOM, GameLobbyRoom);

app.get("/lobbies", async (request, response) => {
  const origin = request.headers.origin;
  const allowed = new Set((process.env.ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
  if (origin && (process.env.NODE_ENV !== "production" || allowed.has(origin))) response.setHeader("access-control-allow-origin", origin);
  const rooms = await matchMaker.query({ name: LOBBY_ROOM, unlisted: false });
  response.json(rooms.map((room) => ({
    roomId: room.roomId,
    roomName: room.metadata?.roomName ?? "이름 없는 원정대",
    clients: room.metadata?.partySize ?? room.clients,
    maxClients: 3,
    phase: room.metadata?.phase ?? "waiting",
    sessionMode: room.metadata?.sessionMode ?? "prototype",
    difficulty: room.metadata?.difficulty ?? "normal",
  })));
});

app.get("/health/live", (_request, response) => {
  response.json({ status: "ok", service: "game-server" });
});
app.get("/health/ready", async (_request, response) => {
  try {
    await checkDatabase();
    response.json({ status: "ready", service: "game-server" });
  } catch {
    response.status(503).json({ status: "not-ready", service: "game-server" });
  }
});

await gameServer.listen(port);
console.log(JSON.stringify({ level: "info", event: "game-server.started", port }));
