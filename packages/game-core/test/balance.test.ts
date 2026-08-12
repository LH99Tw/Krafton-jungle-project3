import assert from "node:assert/strict";
import test from "node:test";
import {
  BOSS_THREE_PLAYER_HP,
  BASE_CRITICAL_CHANCE,
  DIFFICULTY_RULES,
  EQUIPMENT_BALANCE,
  INVADER_BALANCE,
  OFFICIAL_WORLD,
  ZONE_ONE_ENEMY_MULTIPLIERS,
  ZONE_CLEAR_XP,
  CLASS_COMBAT_RULES,
  addAugmentStack,
  addExperience,
  augmentEffectValue,
  createBossEnemy,
  createAugmentDraft,
  createEmptyEquipment,
  createInvaderEnemy,
  createRuntimeWorld,
  createSeededRoomEnemy,
  enemyPatternConfig,
  equipmentBonuses,
  invaderXp,
  partyHpMultiplier,
  waveTotal,
  GameCore,
  type PersonalHiddenDrop,
  type AugmentStacks,
} from "../src/index";

test("mandatory and optional official-map XP budgets reach the intended checkpoints", () => {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "xp-budget", minimumPlayers: 1, world: OFFICIAL_WORLD });
  const mandatoryMonsterXp = ([1, 2, 3] as const).map((zone) => [...core.enemies.values()]
    .filter((enemy) => core.rooms.get(enemy.spawnRoomId)?.zone === zone && enemy.kind !== "hidden")
    .reduce((sum, enemy) => sum + enemy.xpReward, 0));
  const hiddenXp = [...core.enemies.values()].filter((enemy) => enemy.kind === "hidden").reduce((sum, enemy) => sum + enemy.xpReward, 0);
  assert.deepEqual(mandatoryMonsterXp, [222, 449, 519]);
  assert.equal(hiddenXp, 1_417);
  const mandatoryByZone = mandatoryMonsterXp.map((xp, index) => xp + ZONE_CLEAR_XP[(index + 1) as 1 | 2 | 3]);
  let progress = { level: 1, xp: 0 };
  const levels: number[] = [];
  for (const xp of mandatoryByZone) {
    progress = addExperience(progress, xp).progress;
    levels.push(progress.level);
  }
  assert.deepEqual(levels, [10, 18, 25]);
  assert.equal(addExperience(progress, hiddenXp).progress.level, 30);
});

test("difficulty and frozen party size scale every enemy HP deterministically", () => {
  const roomId = createRuntimeWorld("balance-room", "normal").maps.zones[0].startRoomId;
  const solo = createSeededRoomEnemy("balance", roomId, 1, "static", "normal", 0, 0);
  const party = createSeededRoomEnemy("balance", roomId, 1, "static", "normal", 0, 0, undefined, undefined, 3);
  const hard = createSeededRoomEnemy("balance", roomId, 1, "static", "hard", 0, 0, undefined, undefined, 3);
  const zoneOneGate = createSeededRoomEnemy("balance", roomId, 1, "gate", "normal", 0, 0, undefined, undefined, 3);
  const zoneTwoStatic = createSeededRoomEnemy("balance", roomId, 2, "static", "normal", 0, 0, undefined, undefined, 3);
  assert.equal(party.maxHp, Math.round(68 * DIFFICULTY_RULES.normal.hp * partyHpMultiplier(3) * ZONE_ONE_ENEMY_MULTIPLIERS.static.hp));
  assert.equal(hard.maxHp, Math.round(68 * DIFFICULTY_RULES.hard.hp * partyHpMultiplier(3) * ZONE_ONE_ENEMY_MULTIPLIERS.static.hp));
  assert.equal(party.damage, Math.round(7 * DIFFICULTY_RULES.normal.damage * ZONE_ONE_ENEMY_MULTIPLIERS.static.damage));
  assert.equal(hard.damage, Math.round(7 * DIFFICULTY_RULES.hard.damage * ZONE_ONE_ENEMY_MULTIPLIERS.static.damage));
  assert.equal(zoneOneGate.maxHp, Math.round(190 * DIFFICULTY_RULES.normal.hp * partyHpMultiplier(3) * ZONE_ONE_ENEMY_MULTIPLIERS.gate.hp));
  assert.equal(zoneOneGate.damage, Math.round(18 * DIFFICULTY_RULES.normal.damage * ZONE_ONE_ENEMY_MULTIPLIERS.gate.damage));
  assert.equal(zoneTwoStatic.maxHp, Math.round(68 * 1.28 * DIFFICULTY_RULES.normal.hp * partyHpMultiplier(3)));
  assert.ok(party.maxHp > solo.maxHp);

  const normalBoss = createBossEnemy("boss", "normal", 3);
  const hardBoss = createBossEnemy("boss", "hard", 3);
  assert.equal(normalBoss.maxHp, BOSS_THREE_PLAYER_HP.normal);
  assert.equal(hardBoss.maxHp, BOSS_THREE_PLAYER_HP.hard);
  assert.equal(createBossEnemy("boss", "normal", 1).maxHp, Math.round(10_000 / 2.3));
  assert.equal(createBossEnemy("boss", "normal", 2).maxHp, Math.round(10_000 * 1.65 / 2.3));
  assert.equal(normalBoss.damage, 32);
  assert.equal(hardBoss.damage, 41);
});

test("invaders are fifteen percent weaker and grant about twenty percent of static-monster XP", () => {
  const world = createRuntimeWorld("invader-reward", "normal");
  for (const zone of [1, 2, 3] as const) {
    const invader = createInvaderEnemy("invader-reward", zone, 0, world.maps, "normal", 3);
    assert.equal(invader.maxHp, Math.round((22 + zone * 8) * DIFFICULTY_RULES.normal.hp * partyHpMultiplier(3) * INVADER_BALANCE.hp));
    assert.equal(invader.damage, Math.round((7 + zone * 2) * DIFFICULTY_RULES.normal.damage * INVADER_BALANCE.damage));
    assert.equal(invader.xpReward, invaderXp(zone));
  }
  assert.deepEqual(([1, 2, 3] as const).map(invaderXp), [2, 5, 6]);
  assert.equal(waveTotal("day", "normal"), 36);
  assert.equal(waveTotal("day", "hard"), 45);
  assert.equal(waveTotal("night", "normal"), 168);
  assert.equal(waveTotal("night", "hard"), 204);
});

test("each invader grants its small XP reward only once", () => {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "invader-xp-once", minimumPlayers: 1, balancePartySize: 1 });
  const player = core.addPlayer({ userId: "p1", displayName: "Player", heroClass: "swordsman" });
  core.setReady(player.userId, true);
  const invader = core.spawnInvader(1);
  core.movePlayerToRoom(player.userId, invader.roomId);
  player.x = invader.x;
  player.y = invader.y;
  const expected = addExperience({ level: 1, xp: 0 }, invaderXp(1)).progress;
  assert.equal(core.damageEnemy(player.userId, invader.id, invader.hp), true);
  assert.deepEqual(core.teamProgress, { ...expected, xpToNext: core.teamXpToNext });
  assert.equal(invader.xpReward, 0);
  assert.equal(core.damageEnemy(player.userId, invader.id, 1), false);
});

test("equipment uses bounded percentage defense without upgrade scaling", () => {
  assert.deepEqual((["swordsman", "archer", "mage"] as const).map((heroClass) => CLASS_COMBAT_RULES[heroClass].hp), [165, 115, 105]);
  assert.deepEqual((["swordsman", "archer", "mage"] as const).map((heroClass) => CLASS_COMBAT_RULES[heroClass].attackDamage), [15, 10, 12]);
  assert.deepEqual((["swordsman", "archer", "mage"] as const).map((heroClass) => CLASS_COMBAT_RULES[heroClass].attackRange), [180, 460, 400]);
  assert.ok((["swordsman", "archer", "mage"] as const).every((heroClass) => CLASS_COMBAT_RULES[heroClass].attackRange % 10 === 0));
  const item = (slot: PersonalHiddenDrop["slot"]): PersonalHiddenDrop => ({
    id: slot,
    ownerPlayerId: "p1",
    zone: 3,
    hiddenRoomId: "hidden",
    dropIndex: 0,
    rarity: "mythic",
    slot,
    statMultiplier: 1,
    specialOptionCount: 2,
  });
  const loadout = createEmptyEquipment();
  loadout.weapon = item("weapon");
  loadout.armor = item("armor");
  loadout.accessory = item("accessory");
  assert.deepEqual(equipmentBonuses(loadout), {
    attackBonus: EQUIPMENT_BALANCE.attack,
    maxHpBonus: EQUIPMENT_BALANCE.maxHp,
    defenseBonus: EQUIPMENT_BALANCE.defensePercent,
    attackSpeedBonus: EQUIPMENT_BALANCE.attackSpeedPercent,
  });
});

test("zone completion rewards once and respawned static enemies lose their rewards", () => {
  const core = new GameCore({ mode: "prototype", difficulty: "normal", seed: "reward-once", minimumPlayers: 1, balancePartySize: 1, world: OFFICIAL_WORLD });
  const player = core.addPlayer({ userId: "p1", displayName: "Player", heroClass: "swordsman" });
  core.setReady(player.userId, true);
  const zoneOneGates = [...core.enemies.values()].filter((enemy) => enemy.kind === "gate" && core.rooms.get(enemy.roomId)?.zone === 1);
  const gateXp = zoneOneGates.reduce((sum, enemy) => sum + enemy.xpReward, 0);
  for (const gate of zoneOneGates) {
    core.movePlayerToRoom(player.userId, gate.roomId);
    assert.equal(core.damageEnemy(player.userId, gate.id, gate.hp), true);
  }
  const expected = addExperience({ level: 1, xp: 0 }, gateXp + ZONE_CLEAR_XP[1]).progress;
  assert.deepEqual(core.teamProgress, { ...expected, xpToNext: core.teamXpToNext });

  const staticEnemy = [...core.enemies.values()].find((enemy) => enemy.kind === "static" && core.rooms.get(enemy.roomId)?.zone === 1)!;
  core.movePlayerToRoom(player.userId, staticEnemy.roomId);
  core.damageEnemy(player.userId, staticEnemy.id, staticEnemy.hp);
  assert.equal(staticEnemy.xpReward, 0);
});

test("boss pattern density rises at each health threshold without changing cadence", () => {
  const base = enemyPatternConfig("boss", 0);
  for (const intensity of [1, 2, 3]) {
    const phase = enemyPatternConfig("boss", intensity);
    assert.equal(phase.rayCount, base.rayCount + intensity * 4);
    assert.equal(phase.floorCount, base.floorCount + intensity * 2);
    assert.equal(phase.telegraphSeconds, base.telegraphSeconds);
    assert.equal(phase.cooldownSeconds, base.cooldownSeconds);
  }
});

test("one thousand deterministic builds stay inside the level 25 and level 30 DPS budgets", () => {
  const partyDps = (maxLevel: 25 | 30): number[] => Array.from({ length: 1_000 }, (_, seedIndex) => (
    (["swordsman", "archer", "mage"] as const).reduce((sum, heroClass) => {
      let stacks: AugmentStacks = {};
      for (let level = 2; level <= maxLevel; level += 1) {
        const choices = createAugmentDraft({
          runSeed: `balance-${seedIndex}`,
          playerId: `${heroClass}-${seedIndex}`,
          heroClass,
          level,
          stacks,
        });
        stacks = addAugmentStack(stacks, choices[0]!.id);
      }
      return sum + expectedBossBasicDps(heroClass, stacks);
    }, 0)
  )).sort((left, right) => left - right);

  const level25 = partyDps(25);
  const level30 = partyDps(30);
  assert.ok(level25[499]! >= 315 && level25[499]! <= 330, `level 25 median DPS was ${level25[499]}`);
  assert.ok(level30[899]! <= 405, `level 30 p90 DPS was ${level30[899]}`);
  const normalTtk = createBossEnemy("ttk-normal", "normal", 3).maxHp / level25[499]!;
  const hardTtk = createBossEnemy("ttk-hard", "hard", 3).maxHp / level25[499]!;
  assert.ok(normalTtk >= 30 && normalTtk <= 33, `normal boss basic-attack TTK was ${normalTtk}`);
  assert.ok(hardTtk >= 45 && hardTtk <= 49, `hard boss basic-attack TTK was ${hardTtk}`);
});

function expectedBossBasicDps(heroClass: "swordsman" | "archer" | "mage", stacks: AugmentStacks): number {
  const rules = CLASS_COMBAT_RULES[heroClass];
  const attack = rules.attackDamage + 8 + augmentEffectValue(stacks, "power", "amount");
  const attacksPerSecond = (1 + 0.17 + augmentEffectValue(stacks, "haste", "percent") / 100) / rules.attackInterval;
  const criticalChance = BASE_CRITICAL_CHANCE + augmentEffectValue(stacks, "precision", "points") / 100;
  const criticalMultiplier = 1.5 + augmentEffectValue(stacks, "ferocity", "percent") / 100;
  const momentum = 1 + augmentEffectValue(stacks, "momentum", "maxPercent") / 100;
  const bossHunter = 1 + augmentEffectValue(stacks, "boss-hunter", "percent") / 100;
  let classMultiplier = 1;
  if (heroClass === "swordsman") {
    classMultiplier = (1 + 0.3 * augmentEffectValue(stacks, "swordsman-execution", "damagePercent") / 100)
      * (1 + augmentEffectValue(stacks, "swordsman-combo", "damagePercent") / 300);
  } else if (heroClass === "archer") {
    classMultiplier = 1 + augmentEffectValue(stacks, "archer-sniper", "maxPercent") / 100;
  } else {
    classMultiplier = 1 + augmentEffectValue(stacks, "mage-overcharge", "damagePercent") / 400;
  }
  return attack * attacksPerSecond * (1 + criticalChance * (criticalMultiplier - 1)) * momentum * bossHunter * classMultiplier;
}
