import assert from "node:assert/strict";
import test from "node:test";
import { NIGHT_ATTACK_RANGE_MULTIPLIER, PROTOCOL_VERSION } from "@five-days/protocol";
import { GameCore } from "../src/index";

test("starts when all required players are ready and rejects duplicate input", () => {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "test", minimumPlayers: 1 });
  core.addPlayer({ userId: "u1", displayName: "용사", heroClass: "swordsman" });
  assert.equal(core.setReady("u1", true), true);
  assert.equal(core.phase, "day");
  const command = {
    v: PROTOCOL_VERSION,
    type: "player.input" as const,
    seq: 0,
    clientTime: 0,
    payload: { x: 1, y: 0, aim: 0, buttons: 0 },
  } as const;
  assert.equal(core.applyInput("u1", command), true);
  assert.equal(core.applyInput("u1", command), false);
  core.update(0.05);
  assert.ok(core.players.get("u1")!.x > 320);
});

test("advances day phases deterministically", () => {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "test", minimumPlayers: 1 });
  core.addPlayer({ userId: "u1", displayName: "용사", heroClass: "mage" });
  core.setReady("u1", true);
  for (let index = 0; index < 601; index += 1) core.update(0.1);
  assert.equal(core.phase, "night");
});

test("night reduces the authoritative player attack range", () => {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "night-range", minimumPlayers: 1 });
  core.addPlayer({ userId: "u1", displayName: "궁수", heroClass: "archer" });
  core.setReady("u1", true);
  const dayRange = core.combatStats("u1")!.attackRange;

  core.phase = "night";

  assert.equal(core.combatStats("u1")!.attackRange, dayRange * NIGHT_ATTACK_RANGE_MULTIPLIER);
});

test("starts a solo expedition when the lobby fills empty slots with AI", () => {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "solo", minimumPlayers: 1 });
  core.addPlayer({ userId: "solo-user", displayName: "혼자 온 용사", heroClass: "swordsman" });
  assert.equal(core.setReady("solo-user", true), true);
  assert.equal(core.phase, "day");
});
