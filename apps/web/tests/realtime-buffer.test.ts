import assert from "node:assert/strict";
import test from "node:test";
import { ACTOR_COLLISION_RADIUS, OFFICIAL_WORLD } from "@five-days/game-core";
import { PROTOCOL_VERSION, transformFlags, type InputFrame, type TransformSample, type WorldFrame } from "@five-days/protocol";
import {
  areAuthoredBossGatesCleared,
  RealtimeTransformBuffer,
  predictPlayerTransform,
  shouldRenderPartyMember,
} from "../src/game/netcode/RealtimeBuffer";
import { minimapAreaIdForRoom } from "../src/game/transport/ColyseusTransport";

function sample(overrides: Partial<TransformSample> = {}): TransformSample {
  return {
    id: "remote-1",
    roomId: "forest:0",
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    aim: 0,
    flags: transformFlags.none,
    ...overrides,
  };
}

function frame(serverTime: number, transform: TransformSample): WorldFrame {
  return {
    v: PROTOCOL_VERSION,
    serverTick: serverTime,
    serverTime,
    ackInputSeq: 0,
    players: [transform],
    enemies: [],
  };
}

test("interpolates between snapshots and caps extrapolation at 100ms", () => {
  const buffer = new RealtimeTransformBuffer();
  buffer.push(frame(1_000, sample({ x: 0, vx: 10 })), 10);
  buffer.push(frame(1_100, sample({ x: 100, vx: 10 })), 110);

  const interpolated = buffer.sample("remote-1", 1_116.7);
  assert.ok(interpolated);
  assert.ok(Math.abs(interpolated.x - 50) < 0.01);

  const extrapolated = buffer.sample("remote-1", 1_400);
  assert.ok(extrapolated);
  assert.ok(Math.abs(extrapolated.x - 101) < 0.01);
});

test("a discontinuity drops old interpolation history and hard-snaps to the new sample", () => {
  const buffer = new RealtimeTransformBuffer();
  buffer.push(frame(1_000, sample({ x: 10 })), 10);
  buffer.push(frame(1_100, sample({
    roomId: "forest:1",
    x: 500,
    flags: transformFlags.discontinuity,
  })), 110);

  const rendered = buffer.sample("remote-1", 1_116.7);
  assert.equal(rendered?.roomId, "forest:1");
  assert.equal(rendered?.x, 500);
});

test("local prediction normalizes diagonal input before applying class speed", () => {
  const predicted = predictPlayerTransform({
    x: 640,
    y: 360,
    roomId: "forest:0",
    heroClass: "swordsman",
    frame: {
      v: PROTOCOL_VERSION,
      seq: 1,
      clientTime: 0,
      x: 1,
      y: 1,
      aim: 0,
      buttons: 0,
    },
    deltaSeconds: 1 / 60,
    rooms: [{
      id: "forest:0",
      zone: 1,
      x: 0,
      y: 0,
      type: "start",
      visited: true,
      current: true,
      cleared: true,
      connections: [],
    }],
  });
  assert.ok(predicted.x > 640);
  assert.ok(predicted.y > 360);
  assert.ok(Math.abs(predicted.x - 640) < 10);
  assert.ok(Math.abs(predicted.y - 360) < 10);
});

test("official authored-world prediction uses the authoritative floor and collision radius", () => {
  const base = OFFICIAL_WORLD.rooms.find((room) => room.id === OFFICIAL_WORLD.baseRoomId)!;
  const rooms = OFFICIAL_WORLD.rooms.map((room) => ({ id: room.id, rect: room.rect }));
  const frame: InputFrame = {
    v: PROTOCOL_VERSION,
    seq: 1,
    clientTime: 0,
    x: 1,
    y: 0,
    aim: 0,
    buttons: 0,
  };
  const center = predictPlayerTransform({
    x: base.rect.x + base.rect.width / 2,
    y: base.rect.y + base.rect.height / 2,
    roomId: base.id,
    heroClass: "swordsman",
    frame,
    deltaSeconds: 1 / 60,
    rooms: [],
    movementWorld: { walkable: OFFICIAL_WORLD.walkable, rooms },
  });
  assert.ok(center.x > base.rect.x + base.rect.width / 2, "valid floor input must advance immediately");

  const edgeCandidates = [
    { x: base.rect.x + ACTOR_COLLISION_RADIUS, y: base.rect.y + base.rect.height / 2, dx: -1, dy: 0 },
    { x: base.rect.x + base.rect.width - ACTOR_COLLISION_RADIUS, y: base.rect.y + base.rect.height / 2, dx: 1, dy: 0 },
    { x: base.rect.x + base.rect.width / 2, y: base.rect.y + ACTOR_COLLISION_RADIUS, dx: 0, dy: -1 },
    { x: base.rect.x + base.rect.width / 2, y: base.rect.y + base.rect.height - ACTOR_COLLISION_RADIUS, dx: 0, dy: 1 },
  ];
  const sealedEdge = edgeCandidates.find((candidate) => {
    const probeX = candidate.x + candidate.dx * (ACTOR_COLLISION_RADIUS + 1);
    const probeY = candidate.y + candidate.dy * (ACTOR_COLLISION_RADIUS + 1);
    return !OFFICIAL_WORLD.walkable.some((rect) => (
      probeX >= rect.x && probeX < rect.x + rect.width
      && probeY >= rect.y && probeY < rect.y + rect.height
    ));
  });
  assert.ok(sealedEdge, "the authored base must retain at least one exterior wall");

  const wallEdge = predictPlayerTransform({
    x: sealedEdge.x,
    y: sealedEdge.y,
    roomId: base.id,
    heroClass: "swordsman",
    frame: { ...frame, x: sealedEdge.dx, y: sealedEdge.dy },
    deltaSeconds: 1 / 60,
    rooms: [],
    movementWorld: { walkable: OFFICIAL_WORLD.walkable, rooms },
  });
  assert.deepEqual(
    { x: wallEdge.x, y: wallEdge.y },
    { x: sealedEdge.x, y: sealedEdge.y },
    "prediction must match the server wall inset",
  );
});

test("boss prediction opens only after every authored gate is cleared on day three", () => {
  const rooms = [
    { id: "gate-a", cleared: true },
    { id: "gate-b", cleared: false },
  ];
  assert.equal(areAuthoredBossGatesCleared(3, ["gate-a", "gate-b"], rooms), false);
  assert.equal(areAuthoredBossGatesCleared(2, ["gate-a", "gate-b"], rooms.map((room) => ({ ...room, cleared: true }))), false);
  assert.equal(areAuthoredBossGatesCleared(3, ["gate-a", "gate-b"], rooms.map((room) => ({ ...room, cleared: true }))), true);
});

test("remote party visibility is independent of fog radius and follows connection state", () => {
  assert.equal(shouldRenderPartyMember({ connected: true, x: 800, y: 0 }), true);
  assert.equal(shouldRenderPartyMember({ connected: false, x: 100, y: 0 }), false);
  assert.equal(shouldRenderPartyMember({ connected: true, x: 8_001, y: 0 }), true);
});

test("official authored rooms resolve the shared official minimap area", () => {
  assert.equal(minimapAreaIdForRoom("editor:room-base"), "official-map");
  assert.equal(minimapAreaIdForRoom("zone-2:1,1"), "zone-2");
  assert.equal(minimapAreaIdForRoom("unknown"), null);
});
