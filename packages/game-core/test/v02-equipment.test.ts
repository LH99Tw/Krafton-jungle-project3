import assert from "node:assert/strict";
import test from "node:test";
import {
  EQUIPMENT_RARITIES,
  EQUIPMENT_SLOTS,
  rollHiddenDropRarity,
  rollPartyHiddenDrops,
  rollPersonalHiddenDrop,
} from "../src/v02/equipment";

test("exposes the exact rarity multipliers and special-option counts", () => {
  assert.deepEqual(EQUIPMENT_RARITIES, {
    normal: { statMultiplier: 0.2, specialOptionCount: 0 },
    rare: { statMultiplier: 0.4, specialOptionCount: 0 },
    epic: { statMultiplier: 0.6, specialOptionCount: 1 },
    legendary: { statMultiplier: 0.8, specialOptionCount: 0 },
    mythic: { statMultiplier: 1, specialOptionCount: 2 },
  });
  assert.deepEqual(EQUIPMENT_SLOTS, {
    weapon: { stats: ["attack"] },
    armor: { stats: ["maxHp", "defense"] },
    accessory: { stats: ["attackSpeed"] },
  });
});

test("uses an exact 80/20 hidden-drop boundary", () => {
  assert.equal(rollHiddenDropRarity(0), "legendary");
  assert.equal(rollHiddenDropRarity(0.799_999), "legendary");
  assert.equal(rollHiddenDropRarity(0.8), "mythic");
  assert.equal(rollHiddenDropRarity(0.999_999), "mythic");
  assert.throws(() => rollHiddenDropRarity(-0.001), RangeError);
  assert.throws(() => rollHiddenDropRarity(1), RangeError);
});

test("personal rolls are deterministic and independent of party ordering", () => {
  const context = { runSeed: "personal-run", zone: 2 as const, hiddenRoomId: "zone-2:3,3", dropIndex: 1 };
  const direct = rollPersonalHiddenDrop({ ...context, playerId: "player-b" });
  assert.deepEqual(direct, rollPersonalHiddenDrop({ ...context, playerId: "player-b" }));

  const forward = rollPartyHiddenDrops({ ...context, playerIds: ["player-a", "player-b", "player-c"] });
  const reverse = rollPartyHiddenDrops({ ...context, playerIds: ["player-c", "player-b", "player-a"] });
  assert.deepEqual(
    [...forward].sort((left, right) => left.ownerPlayerId.localeCompare(right.ownerPlayerId)),
    [...reverse].sort((left, right) => left.ownerPlayerId.localeCompare(right.ownerPlayerId)),
  );
  assert.deepEqual(forward.find((drop) => drop.ownerPlayerId === "player-b"), direct);
  assert.equal(new Set(forward.map((drop) => drop.id)).size, 3);
  assert.throws(() => rollPartyHiddenDrops({ ...context, playerIds: ["same", "same"] }), RangeError);
});

test("property: deterministic rolls approximate 80/20 and always match rarity metadata", () => {
  let legendary = 0;
  let mythic = 0;
  const slots = new Set<string>();
  for (let index = 0; index < 20_000; index += 1) {
    const drop = rollPersonalHiddenDrop({
      runSeed: `distribution-${index}`,
      playerId: `player-${index}`,
      zone: ((index % 3) + 1) as 1 | 2 | 3,
      hiddenRoomId: `hidden-${index % 6}`,
    });
    if (drop.rarity === "legendary") legendary += 1;
    else mythic += 1;
    slots.add(drop.slot);
    assert.equal(drop.statMultiplier, EQUIPMENT_RARITIES[drop.rarity].statMultiplier);
    assert.equal(drop.specialOptionCount, EQUIPMENT_RARITIES[drop.rarity].specialOptionCount);
  }

  const legendaryRate = legendary / (legendary + mythic);
  assert.ok(legendaryRate > 0.78 && legendaryRate < 0.82, `legendary rate was ${legendaryRate}`);
  assert.deepEqual([...slots].sort(), ["accessory", "armor", "weapon"]);
});
