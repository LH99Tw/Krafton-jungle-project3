import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL_VERSION, transformFlags, type TransformSample, type WorldFrame } from "@five-days/protocol";
import {
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

test("remote party visibility is independent of fog radius and follows connection state", () => {
  const viewer = { x: 0, y: 0 };
  assert.equal(shouldRenderPartyMember({ connected: true, x: 800, y: 0 }, viewer), true);
  assert.equal(shouldRenderPartyMember({ connected: false, x: 100, y: 0 }, viewer), false);
  assert.equal(shouldRenderPartyMember({ connected: true, x: 8_001, y: 0 }, viewer), true);
});

test("official authored rooms resolve the shared official minimap area", () => {
  assert.equal(minimapAreaIdForRoom("editor:room-base"), "official-map");
  assert.equal(minimapAreaIdForRoom("zone-2:1,1"), "zone-2");
  assert.equal(minimapAreaIdForRoom("unknown"), null);
});
