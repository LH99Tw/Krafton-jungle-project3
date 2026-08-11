import assert from "node:assert/strict";
import test from "node:test";
import {
  selectVisionRevealSources,
} from "../src/game/runtime/room/vision";

test("player vision keeps priority while installed lanterns are deterministic and bounded", () => {
  const selected = selectVisionRevealSources(
    { id: "player", x: 10, y: 20, radius: 330 },
    [
      { id: "lantern-b", x: 500, y: 400, radius: 180 },
      { id: "lantern-a", x: 300, y: 200, radius: 160 },
      { id: "broken", x: 0, y: 0, radius: 0 },
    ],
    2,
  );

  assert.deepEqual(selected.map((source) => source.id), ["player", "lantern-a"]);
});
