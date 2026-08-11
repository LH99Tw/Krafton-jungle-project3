import assert from "node:assert/strict";
import test from "node:test";
import { GameCore, cellIndexAt, decodeMask, isExplored, roomWorldCenter } from "@five-days/game-core";
import { PartyExploration } from "../src/minimap";

test("server exploration merges connected living party members and survives re-init", () => {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "minimap-party-test", minimumPlayers: 3 });
  const rooms = [...core.rooms.values()].filter((room) => room.zone === 1).slice(0, 3);
  rooms.forEach((room, index) => {
    const player = core.addPlayer({ userId: `player-${index}`, displayName: `용사 ${index}`, heroClass: "swordsman" });
    const center = roomWorldCenter({ x: room.gridX, y: room.gridY });
    player.roomId = room.id;
    player.x = center.x;
    player.y = center.y;
    player.connected = true;
    player.alive = true;
  });
  const exploration = new PartyExploration(core);
  exploration.update();
  const first = exploration.init("zone-1");
  assert.ok(first);
  const mask = decodeMask(first.explorationMask, Math.ceil(first.geometry.columns * first.geometry.rows / 8));
  for (const player of core.players.values()) assert.equal(isExplored(mask, cellIndexAt(first.geometry, player.x, player.y)), true);
  const restored = exploration.init("zone-1");
  assert.equal(restored?.explorationMask, first.explorationMask);
});
