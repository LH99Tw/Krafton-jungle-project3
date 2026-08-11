import { Room, type AuthContext, type Client } from "@colyseus/core";
import { type GameTicketClaims } from "@five-days/auth";
import {
  GLOBAL_CHAT_ROOM,
  lobbyChatSchema,
  type LobbyChatMessage,
} from "@five-days/protocol";
import { authorizeGameConnection, recordProtocolViolation, registerConnection, unregisterConnection } from "./security";

export const GLOBAL_CHAT_HISTORY_LIMIT = 100;

export class GlobalChatRoom extends Room {
  autoDispose = false;
  private readonly messages: LobbyChatMessage[] = [];
  private readonly chatWindows = new Map<string, { startedAt: number; count: number }>();
  private readonly historySent = new Set<string>();

  static async onAuth(token: string, _options: unknown, context: AuthContext): Promise<GameTicketClaims> {
    return authorizeGameConnection(token, context, "global_chat");
  }

  onCreate(): void {
    this.onMessage("global.chat", (client, message) => this.chat(client, message));
    this.onMessage("global.chat-history", (client) => {
      if (this.historySent.has(client.sessionId)) return recordProtocolViolation(client, "HISTORY_RATE_LIMITED");
      this.historySent.add(client.sessionId);
      client.send("global.chat-history", this.messages);
    });
  }

  onJoin(client: Client, _options: unknown, auth: GameTicketClaims): void {
    const duplicate = [...this.clients].find((item) => item !== client && item.auth?.sub === auth.sub);
    duplicate?.leave(4009, "DUPLICATE_LOGIN");
    client.userData = { userId: auth.sub, displayName: auth.displayName };
    registerConnection("global_chat", auth.sub, client);
  }

  onLeave(client: Client): void {
    const userId = client.userData?.userId as string | undefined;
    if (userId) {
      this.chatWindows.delete(userId);
      unregisterConnection("global_chat", userId, client);
    }
    this.historySent.delete(client.sessionId);
  }

  private chat(client: Client, raw: unknown): void {
    const parsed = lobbyChatSchema.safeParse(raw);
    const userId = client.userData?.userId as string | undefined;
    const displayName = client.userData?.displayName as string | undefined;
    if (!parsed.success || !userId || !displayName) {
      recordProtocolViolation(client, "INVALID_CHAT");
      return this.error(client, "INVALID_CHAT", "메시지는 1~180자의 일반 텍스트만 사용할 수 있습니다.");
    }
    if (!this.allowChat(userId)) {
      recordProtocolViolation(client, "CHAT_RATE_LIMITED");
      return this.error(client, "CHAT_RATE_LIMITED", "메시지를 너무 빠르게 보내고 있습니다.");
    }
    const message: LobbyChatMessage = {
      id: crypto.randomUUID(),
      userId,
      displayName,
      message: parsed.data.message,
      sentAt: Date.now(),
    };
    retainRecentMessages(this.messages, message);
    this.broadcast("global.chat", message);
  }

  private allowChat(userId: string): boolean {
    const now = Date.now();
    const window = this.chatWindows.get(userId);
    if (!window || now - window.startedAt >= 10_000) {
      this.chatWindows.set(userId, { startedAt: now, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= 5;
  }

  private error(client: Client, code: string, message: string): void {
    client.send("global.error", { code, message });
  }
}

export function retainRecentMessages<T>(messages: T[], next: T, limit = GLOBAL_CHAT_HISTORY_LIMIT): void {
  messages.push(next);
  if (messages.length > limit) messages.splice(0, messages.length - limit);
}

export { GLOBAL_CHAT_ROOM };
