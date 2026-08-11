import assert from "node:assert/strict";
import test from "node:test";
import { resolveRuntimeOptions } from "../src/game/domain/runtimeOptions";

const options = {
  heroClass: "archer",
  sessionMode: "prototype",
  difficulty: "normal",
  partyMode: "coop",
} as const;

test("uses the authoritative network scene after connecting to the game server", () => {
  assert.equal(resolveRuntimeOptions(options, "ws://localhost:2567").networked, true);
});

test("keeps the offline fallback on the local scene", () => {
  assert.equal(resolveRuntimeOptions(options, "").networked, false);
});
