import { createServer } from "node:http";
import express from "express";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { checkDatabase } from "@five-days/db";
import { PARTY_ROOM, PartyRoom } from "./party-room.js";

const port = Number(process.env.PORT ?? 2567);
const app = express();
const httpServer = createServer(app);
const gameServer = new Server({ transport: new WebSocketTransport({ server: httpServer, pingInterval: 10_000, maxPayload: 4096 }) });

gameServer.define(PARTY_ROOM, PartyRoom);

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
