import { Client, type Room } from "colyseus.js";
import {
  GLOBAL_CHAT_ROOM,
  PROTOCOL_VERSION,
  type LobbyChatMessage,
} from "@five-days/protocol";

type GlobalChatEventMap = {
  chat: LobbyChatMessage;
  history: LobbyChatMessage[];
  error: { code: string; message: string };
  disconnected: { code: number; reason: string };
};

class GlobalChatTransport {
  private room: Room | null = null;
  private readonly listeners = new Map<keyof GlobalChatEventMap, Set<(value: never) => void>>();

  on<K extends keyof GlobalChatEventMap>(event: K, callback: (value: GlobalChatEventMap[K]) => void): () => void {
    const callbacks = this.listeners.get(event) ?? new Set();
    callbacks.add(callback as (value: never) => void);
    this.listeners.set(event, callbacks);
    return () => callbacks.delete(callback as (value: never) => void);
  }

  async connect(input: { serverUrl: string; csrfToken: string }): Promise<void> {
    await this.leave();
    const token = await fetchTicket(input.csrfToken);
    const client = new Client(input.serverUrl);
    client.auth.token = token;
    const room = await client.joinOrCreate(GLOBAL_CHAT_ROOM, { protocolVersion: PROTOCOL_VERSION });
    this.room = room;
    room.onMessage("global.chat", (message: LobbyChatMessage) => this.emit("chat", message));
    room.onMessage("global.chat-history", (messages: LobbyChatMessage[]) => this.emit("history", messages));
    room.onMessage("global.error", (error: { code: string; message: string }) => this.emit("error", error));
    room.onLeave((code, reason) => {
      if (this.room === room) this.emit("disconnected", { code, reason: reason ?? "전체 채팅 연결이 종료되었습니다." });
    });
    room.send("global.chat-history");
  }

  chat(message: string): void {
    this.room?.send("global.chat", { message });
  }

  async leave(): Promise<void> {
    const room = this.room;
    this.room = null;
    room?.removeAllListeners();
    if (room) await room.leave(true);
  }

  private emit<K extends keyof GlobalChatEventMap>(event: K, value: GlobalChatEventMap[K]): void {
    for (const callback of this.listeners.get(event) ?? []) callback(value as never);
  }
}

async function fetchTicket(csrfToken: string): Promise<string> {
  const response = await fetch("/api/game-ticket", {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
    body: JSON.stringify({ room: "global_chat" }),
  });
  const text = await response.text();
  let value: { token?: string; error?: { message?: string } } = {};
  try { value = text ? JSON.parse(text) as typeof value : {}; } catch { /* handled below */ }
  if (!response.ok || !value.token || value.token.split(".").length !== 3) {
    throw new Error(value.error?.message || "전체 채팅 접속 티켓을 발급하지 못했습니다.");
  }
  return value.token;
}

export const globalChatTransport = new GlobalChatTransport();
