import {
  ACTOR_COLLISION_RADIUS,
  BOSS_ROOM_ID,
  CLASS_COMBAT_RULES,
  bossWorldRect,
  buildWorldFromRooms,
  resolveWalkablePoint,
  resolveWalkableDiscPoint,
  roomContainingPoint,
  roomIdToGrid,
  type WorldRect,
} from "@five-days/game-core";
import { transformFlags, type InputFrame, type TransformSample, type WorldFrame } from "@five-days/protocol";
import type { HeroClassId, RoomMapCell } from "../domain/types";

type TimedTransform = TransformSample & { serverTime: number };

export function shouldRenderPartyMember(
  member: { connected: boolean; x: number; y: number },
): boolean {
  return member.connected;
}

export function areAuthoredBossGatesCleared(
  day: number,
  gateRoomIds: readonly string[],
  rooms: readonly Readonly<{ id: string; cleared: boolean }>[],
): boolean {
  return day >= 3 && gateRoomIds.length > 0 && gateRoomIds.every((gateRoomId) => (
    rooms.some((room) => room.id === gateRoomId && room.cleared)
  ));
}

export class RealtimeTransformBuffer {
  private readonly samples = new Map<string, TimedTransform[]>();
  private readonly lastSeenAt = new Map<string, number>();
  private jitterMs = 0;
  private previousArrivalAt = 0;
  private previousServerTime = 0;

  push(frame: WorldFrame, arrivalAt = performance.now()): void {
    if (this.previousArrivalAt > 0) {
      const arrivalDelta = arrivalAt - this.previousArrivalAt;
      const serverDelta = frame.serverTime - this.previousServerTime;
      const deviation = Math.abs(arrivalDelta - serverDelta);
      this.jitterMs += (deviation - this.jitterMs) * 0.1;
    }
    this.previousArrivalAt = arrivalAt;
    this.previousServerTime = frame.serverTime;
    for (const sample of [...frame.players, ...frame.enemies]) {
      this.pushSample(sample, frame.serverTime);
      this.lastSeenAt.set(sample.id, arrivalAt);
    }
  }

  get interpolationDelayMs(): number {
    return clamp(66.7 + this.jitterMs * 2, 50, 100);
  }

  sample(id: string, now = Date.now()): TransformSample | null {
    const history = this.samples.get(id);
    if (!history?.length) return null;
    const targetTime = now - this.interpolationDelayMs;
    if (history.length === 1 || targetTime <= history[0].serverTime) return stripTime(history[0]);
    for (let index = 1; index < history.length; index += 1) {
      const right = history[index];
      if (right.serverTime < targetTime) continue;
      const left = history[index - 1];
      const span = Math.max(1, right.serverTime - left.serverTime);
      const alpha = clamp((targetTime - left.serverTime) / span, 0, 1);
      return {
        ...right,
        x: lerp(left.x, right.x, alpha),
        y: lerp(left.y, right.y, alpha),
        vx: lerp(left.vx, right.vx, alpha),
        vy: lerp(left.vy, right.vy, alpha),
        aim: lerpAngle(left.aim, right.aim, alpha),
      };
    }
    const latest = history.at(-1) as TimedTransform;
    const extrapolationMs = clamp(targetTime - latest.serverTime, 0, 100);
    return {
      ...stripTime(latest),
      x: latest.x + latest.vx * extrapolationMs / 1000,
      y: latest.y + latest.vy * extrapolationMs / 1000,
    };
  }

  isFresh(id: string, now = performance.now(), maximumAgeMs = 150): boolean {
    return now - (this.lastSeenAt.get(id) ?? Number.NEGATIVE_INFINITY) <= maximumAgeMs;
  }

  clear(): void {
    this.samples.clear();
    this.lastSeenAt.clear();
    this.jitterMs = 0;
    this.previousArrivalAt = 0;
    this.previousServerTime = 0;
  }

  private pushSample(sample: TransformSample, serverTime: number): void {
    const current = this.samples.get(sample.id) ?? [];
    if ((sample.flags & transformFlags.discontinuity) !== 0) current.length = 0;
    if (current.at(-1)?.serverTime === serverTime) current[current.length - 1] = { ...sample, serverTime };
    else current.push({ ...sample, serverTime });
    if (current.length > 32) current.splice(0, current.length - 32);
    this.samples.set(sample.id, current);
  }
}

export function predictPlayerTransform(input: {
  x: number;
  y: number;
  roomId: string;
  heroClass: HeroClassId;
  frame: InputFrame;
  deltaSeconds: number;
  rooms: readonly RoomMapCell[];
  movementWorld?: Readonly<{
    walkable: readonly WorldRect[];
    rooms: readonly Readonly<{ id: string; rect: WorldRect }>[];
  }>;
}): { x: number; y: number; roomId: string } {
  const magnitude = Math.hypot(input.frame.x, input.frame.y);
  const scale = magnitude > 1 ? 1 / magnitude : 1;
  const speed = CLASS_COMBAT_RULES[input.heroClass].speed;
  const deltaX = input.frame.x * scale * speed * input.deltaSeconds;
  const deltaY = input.frame.y * scale * speed * input.deltaSeconds;
  if (input.movementWorld) {
    const resolved = resolveWalkableDiscPoint(
      input.movementWorld.walkable,
      input.x + deltaX,
      input.y + deltaY,
      input.x,
      input.y,
      ACTOR_COLLISION_RADIUS,
    );
    const containing = input.movementWorld.rooms.find(({ rect }) => (
      resolved.x >= rect.x
      && resolved.x < rect.x + rect.width
      && resolved.y >= rect.y
      && resolved.y < rect.y + rect.height
    ));
    return { x: resolved.x, y: resolved.y, roomId: containing?.id ?? input.roomId };
  }
  if (input.roomId === BOSS_ROOM_ID) {
    const rect = bossWorldRect();
    return {
      roomId: input.roomId,
      x: clamp(input.x + deltaX, rect.x + 28, rect.x + rect.width - 28),
      y: clamp(input.y + deltaY, rect.y + 28, rect.y + rect.height - 28),
    };
  }
  const localRoom = input.rooms.find((room) => room.id === input.roomId);
  const zone = localRoom?.zone;
  const roomLikes = new Map<string, { id: string; gridX: number; gridY: number; connections: string[] }>();
  for (const room of input.rooms) {
    if (zone && room.zone !== zone) continue;
    roomLikes.set(room.id, { id: room.id, gridX: room.x, gridY: room.y, connections: [...room.connections] });
    for (const connectedId of room.connections) {
      if (roomLikes.has(connectedId)) continue;
      const grid = roomIdToGrid(connectedId);
      if (grid) roomLikes.set(connectedId, { id: connectedId, gridX: grid.x, gridY: grid.y, connections: [room.id] });
    }
  }
  const world = buildWorldFromRooms(roomLikes.values(), false);
  const resolved = resolveWalkablePoint(world.rects, input.x + deltaX, input.y + deltaY, input.x, input.y);
  return {
    x: resolved.x,
    y: resolved.y,
    roomId: roomContainingPoint(world.grid, resolved.x, resolved.y) ?? input.roomId,
  };
}

function stripTime(sample: TimedTransform): TransformSample {
  return {
    id: sample.id,
    roomId: sample.roomId,
    x: sample.x,
    y: sample.y,
    vx: sample.vx,
    vy: sample.vy,
    aim: sample.aim,
    flags: sample.flags,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function lerp(left: number, right: number, alpha: number): number {
  return left + (right - left) * alpha;
}

function lerpAngle(left: number, right: number, alpha: number): number {
  const difference = Math.atan2(Math.sin(right - left), Math.cos(right - left));
  return left + difference * alpha;
}
