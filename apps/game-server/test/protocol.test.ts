import assert from "node:assert/strict";
import test from "node:test";
import {
  PROTOCOL_VERSION,
  clientCommandSchema,
  lobbyChatSchema,
  lobbyClassSelectSchema,
  lobbyCreateOptionsSchema,
} from "@five-days/protocol";
import { consumeGameTicket } from "../src/party-room";

test("rejects out-of-range player input", () => {
  const result = clientCommandSchema.safeParse({
    v: PROTOCOL_VERSION,
    type: "player.input",
    seq: 1,
    clientTime: 0,
    payload: { x: 99, y: 0, aim: 0, buttons: 0 },
  });
  assert.equal(result.success, false);
});

test("consumes each game ticket jti only once", () => {
  const now = Date.now();
  const claims = { jti: `ticket-${now}`, exp: Math.floor(now / 1000) + 90 };
  assert.equal(consumeGameTicket(claims, now), true);
  assert.equal(consumeGameTicket(claims, now + 1), false);
});

test("validates public lobby creation and nullable class selection", () => {
  assert.equal(lobbyCreateOptionsSchema.safeParse({
    roomName: "새벽 원정대",
    sessionMode: "prototype",
    difficulty: "normal",
    protocolVersion: PROTOCOL_VERSION,
  }).success, true);
  assert.equal(lobbyCreateOptionsSchema.safeParse({
    roomName: "x",
    sessionMode: "prototype",
    difficulty: "normal",
    protocolVersion: PROTOCOL_VERSION,
  }).success, false);
  assert.equal(lobbyClassSelectSchema.safeParse({ heroClass: "mage" }).success, true);
  assert.equal(lobbyClassSelectSchema.safeParse({ heroClass: null }).success, true);
});

test("limits party chat payload length", () => {
  assert.equal(lobbyChatSchema.safeParse({ message: "원정 준비 완료" }).success, true);
  assert.equal(lobbyChatSchema.safeParse({ message: "x".repeat(181) }).success, false);
});
