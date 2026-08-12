import assert from "node:assert/strict";
import test from "node:test";
import type { MiniMapSnapshot } from "../src/game/domain/types";
import { fullMapScale, mapTransform } from "../src/features/game/RoomMiniMap";

function minimap(boundsWidth = 8_000, boundsHeight = 12_000): MiniMapSnapshot {
  return {
    geometry: {
      mapRevision: "open-world-test",
      areaId: "official-map",
      bounds: { x: -2_000, y: -3_000, width: boundsWidth, height: boundsHeight },
      cellSize: 64,
      columns: 1,
      rows: 1,
      surfaces: [],
      wallSegments: [],
      visionRadius: 800,
      markers: [],
    },
    explorationMask: new Uint8Array(1),
    revision: 0,
  };
}

test("minimap scale stays positive while the HUD temporarily collapses during a zone transition", () => {
  const snapshot = minimap();
  for (const [width, height] of [[0, 0], [1, 1], [12, 18], [320, 240]]) {
    const scale = fullMapScale(width!, height!, snapshot);
    const transform = mapTransform(width!, height!, snapshot, { x: 4_000, y: 6_000 });
    assert.ok(Number.isFinite(scale) && scale > 0);
    assert.ok(Number.isFinite(transform.scale) && transform.scale > 0);
    assert.ok(snapshot.geometry.visionRadius * transform.scale > 0);
  }
});

test("minimap transform falls back safely for malformed transient geometry", () => {
  const snapshot = minimap(0, Number.NaN);
  const transform = mapTransform(0, 0, snapshot, { x: 0, y: 0 }, { zoom: -2, centerX: null, centerY: null });
  assert.ok(Number.isFinite(transform.scale));
  assert.ok(transform.scale > 0);
});
