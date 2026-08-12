import assert from "node:assert/strict";
import test from "node:test";
import {
  AUGMENT_DEFINITIONS,
  GENERAL_AUGMENTS,
  MAX_LEVEL,
  MILESTONE_AUGMENTS,
  MILESTONE_LEVELS,
  addAugmentStack,
  addExperience,
  createAugmentDraft,
  describeAugment,
  isMilestoneLevel,
  migrateAugmentStacks,
  xpRequiredForNextLevel,
  type AugmentId,
  type AugmentStacks,
} from "../src/v02/progression";

test("caps progression at level 30 and reports every crossed level", () => {
  assert.equal(MAX_LEVEL, 30);
  assert.deepEqual(MILESTONE_LEVELS, [10, 20, 30]);
  assert.equal(xpRequiredForNextLevel(1), 20);
  assert.equal(xpRequiredForNextLevel(2), 30);
  assert.equal(xpRequiredForNextLevel(29), 280);
  assert.equal(xpRequiredForNextLevel(30), null);
  for (let level = 1; level < MAX_LEVEL; level += 1) {
    assert.equal((xpRequiredForNextLevel(level) ?? 0) % 10, 0);
  }

  const oneLevel = addExperience({ level: 1, xp: 0 }, 20);
  assert.deepEqual(oneLevel.progress, { level: 2, xp: 0 });
  assert.deepEqual(oneLevel.gainedLevels, [2]);

  const capped = addExperience({ level: 1, xp: 0 }, 100_000);
  assert.equal(capped.progress.level, 30);
  assert.equal(capped.progress.xp, 0);
  assert.deepEqual(capped.gainedLevels, Array.from({ length: 29 }, (_, index) => index + 2));
  assert.ok(capped.discardedXp > 0);

  const alreadyCapped = addExperience({ level: 30, xp: 0 }, 500);
  assert.deepEqual(alreadyCapped, {
    progress: { level: 30, xp: 0 },
    gainedLevels: [],
    discardedXp: 500,
  });
});

test("general pool is attack-only and has enough capacity for 26 regular choices", () => {
  assert.equal(GENERAL_AUGMENTS.reduce((sum, augment) => sum + augment.maxStacks, 0), 33);
  assert.equal(GENERAL_AUGMENTS.length, 12);
  assert.ok(GENERAL_AUGMENTS.every((augment) => augment.pool === "general"));
  assert.ok(GENERAL_AUGMENTS.every((augment) => augment.maxStacks >= 1));
  assert.ok(GENERAL_AUGMENTS.every((augment) => [
    "attack-flat",
    "attack-speed-percent",
    "skill-power-percent",
    "critical-chance-points",
    "major-target-damage-percent",
    "skill-cooldown-reduction-percent",
    "consecutive-hit-damage",
    "nth-attack-damage",
    "crit-loop",
    "area-power",
    "split-attack",
    "chain-explosion",
  ].includes(augment.effect.kind)));
});

test("range augments are all epic and carry direct damage so they stay relevant on bosses", () => {
  const rangeKinds = new Set(["area-power", "split-attack"]);
  const rangeAugments = GENERAL_AUGMENTS.filter((augment) => rangeKinds.has(augment.effect.kind));
  assert.equal(rangeAugments.length, 2);
  assert.ok(rangeAugments.every((augment) => augment.rarity === "epic"));
  for (const augment of rangeAugments) {
    const values = Object.values(augment.effect.values);
    assert.ok(values.some((value) => (augment.effect.kind === "area-power" ? value > 0 : value > 0)), `${augment.id} should keep a direct damage component`);
  }
});

test("each class has five one-time milestone augments, all epic", () => {
  for (const heroClass of ["swordsman", "archer", "mage"] as const) {
    const definitions = MILESTONE_AUGMENTS.filter((augment) => augment.classId === heroClass);
    assert.equal(definitions.length, 5);
    assert.ok(definitions.every((augment) => augment.pool === "milestone" && augment.maxStacks === 1 && augment.rarity === "epic"));
  }
});

test("drafts are deterministic and independent of stack object insertion order", () => {
  const firstStacks: AugmentStacks = { power: 1, haste: 2 };
  const secondStacks: AugmentStacks = { haste: 2, power: 1 };
  const input = {
    runSeed: "draft-order",
    playerId: "player-1",
    heroClass: "mage" as const,
    level: 8,
    draftIndex: 3,
  };
  assert.deepEqual(
    createAugmentDraft({ ...input, stacks: firstStacks }),
    createAugmentDraft({ ...input, stacks: secondStacks }),
  );
});

test("property: every legal level path receives three unique choices through level 30", () => {
  for (const heroClass of ["swordsman", "archer", "mage"] as const) {
    for (let run = 0; run < 250; run += 1) {
      let stacks: AugmentStacks = {};
      for (let level = 2; level <= MAX_LEVEL; level += 1) {
        const draft = createAugmentDraft({
          runSeed: `path-${run}`,
          playerId: `player-${run % 7}`,
          heroClass,
          level,
          stacks,
          draftIndex: level,
        });
        assert.equal(draft.length, 3, `${heroClass}, run ${run}, level ${level}`);
        assert.equal(new Set(draft.map((augment) => augment.id)).size, 3);
        if (isMilestoneLevel(level)) {
          assert.ok(draft.every((augment) => augment.pool === "milestone" && augment.classId === heroClass));
        } else {
          assert.ok(draft.every((augment) => augment.pool === "general" && augment.classId === undefined));
        }
        const selected = draft[(run + level) % draft.length];
        stacks = addAugmentStack(stacks, selected.id);
      }
    }
  }
});

test("rejects illegal levels and stacking past the definition maximum", () => {
  const input = {
    runSeed: "invalid",
    playerId: "player",
    heroClass: "swordsman" as const,
    stacks: {},
  };
  assert.throws(() => createAugmentDraft({ ...input, level: 1 }), RangeError);
  assert.throws(() => createAugmentDraft({ ...input, level: 31 }), RangeError);

  let stacks: AugmentStacks = {};
  for (let index = 0; index < 5; index += 1) stacks = addAugmentStack(stacks, "power");
  assert.throws(() => addAugmentStack(stacks, "power"), RangeError);
});

test("level 30 still issues the third milestone choice", () => {
  const chosen: AugmentId[] = ["archer-volley", "archer-sniper"];
  let stacks: AugmentStacks = {};
  for (const id of chosen) stacks = addAugmentStack(stacks, id);
  const draft = createAugmentDraft({
    runSeed: "last-milestone",
    playerId: "archer-player",
    heroClass: "archer",
    level: 30,
    stacks,
  });
  assert.equal(draft.length, 3);
  assert.ok(draft.every((augment) => augment.classId === "archer" && !chosen.includes(augment.id)));
});

test("every description is auto-generated and non-empty", () => {
  for (const augment of AUGMENT_DEFINITIONS) {
    assert.equal(augment.description, describeAugment(augment));
    assert.ok((augment.description ?? "").length > 0, `${augment.id} description must not be empty`);
  }
});

test("legacy ferocity stacks migrate 1:1 into crit-loop, capped at its max", () => {
  const migrated = migrateAugmentStacks({ ferocity: 3, power: 2, unknown: 4 });
  assert.deepEqual(migrated, { "crit-loop": 2, power: 2 });
});
