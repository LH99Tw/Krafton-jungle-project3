import { Client, type Room } from "colyseus.js";
import { PARTY_ROOM, PROTOCOL_VERSION, type RoomOptions } from "@five-days/protocol";

export type NetworkStatus = "idle" | "connecting" | "connected" | "disconnected" | "error";

type TicketResponse = { token: string; expiresAt: string };

export class ColyseusTransport {
  private room: Room | null = null;
  private seq = 0;
  private inputTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pressed = new Set<string>();
  private aim = 0;
  private cleanupInput: (() => void) | null = null;

  async connect(input: {
    serverUrl: string;
    csrfToken: string;
    options: Omit<RoomOptions, "protocolVersion">;
    roomId?: string;
  }): Promise<void> {
    this.disconnect();
    const ticketResponse = await fetch("/api/game-ticket", {
      method: "POST",
      headers: { "x-csrf-token": input.csrfToken },
    });
    if (!ticketResponse.ok) throw new Error("게임 접속 티켓을 발급하지 못했습니다.");
    const ticket = await ticketResponse.json() as TicketResponse;
    const client = new Client(input.serverUrl);
    client.auth.token = ticket.token;
    const roomOptions = {
      ...input.options,
      protocolVersion: PROTOCOL_VERSION,
    };
    this.room = input.roomId
      ? await client.joinById(input.roomId, roomOptions)
      : await client.joinOrCreate(PARTY_ROOM, roomOptions);
    this.send("room.ready", { ready: true });
    this.startInputCapture();
  }

  disconnect(): void {
    if (this.inputTimer) clearInterval(this.inputTimer);
    this.inputTimer = null;
    this.cleanupInput?.();
    this.cleanupInput = null;
    this.pressed.clear();
    void this.room?.leave(true);
    this.room = null;
  }

  private send(type: string, payload: unknown): void {
    if (!this.room) return;
    this.room.send(type, {
      v: PROTOCOL_VERSION,
      type,
      seq: this.seq++,
      clientTime: performance.now(),
      payload,
    });
  }

  private startInputCapture(): void {
    const onKeyDown = (event: KeyboardEvent) => this.pressed.add(event.code);
    const onKeyUp = (event: KeyboardEvent) => this.pressed.delete(event.code);
    const onPointerMove = (event: PointerEvent) => {
      this.aim = Math.atan2(event.clientY - window.innerHeight / 2, event.clientX - window.innerWidth / 2);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("pointermove", onPointerMove);
    this.inputTimer = setInterval(() => {
      const x = Number(this.pressed.has("KeyD")) - Number(this.pressed.has("KeyA"));
      const y = Number(this.pressed.has("KeyS")) - Number(this.pressed.has("KeyW"));
      const buttons =
        Number(this.pressed.has("KeyQ")) |
        (Number(this.pressed.has("KeyE")) << 1) |
        (Number(this.pressed.has("Space")) << 2);
      this.send("player.input", { x, y, aim: this.aim, buttons });
    }, 50);

    this.cleanupInput = () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointermove", onPointerMove);
    };
  }
}

export const colyseusTransport = new ColyseusTransport();
