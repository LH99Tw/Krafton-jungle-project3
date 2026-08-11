import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { GameCore, OFFICIAL_MAP_MANIFEST, OFFICIAL_WORLD } from "../src/index";

test("official manifest revision matches its canonical authored map", () => {
  const revision = crypto.createHash("sha256").update(JSON.stringify(OFFICIAL_MAP_MANIFEST.map)).digest("hex");
  assert.equal(OFFICIAL_MAP_MANIFEST.schemaVersion, 1);
  assert.equal(OFFICIAL_MAP_MANIFEST.mapRevision, revision);
});

test("official world starts at the authored base and connects through the boss", () => {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "official-test", minimumPlayers: 1, world: OFFICIAL_WORLD });
  const player = core.addPlayer({ userId: "player", displayName: "Player", heroClass: "swordsman" });
  assert.equal(player.roomId, OFFICIAL_WORLD.baseRoomId);
  assert.equal(core.rooms.size, OFFICIAL_WORLD.rooms.length);
  const visited = new Set<string>([OFFICIAL_WORLD.baseRoomId]);
  const queue: string[] = [OFFICIAL_WORLD.baseRoomId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of OFFICIAL_WORLD.rooms.find((room) => room.id === current)?.connections ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
    }
  }
  assert.equal(visited.has(OFFICIAL_WORLD.bossRoomId), true);
});
