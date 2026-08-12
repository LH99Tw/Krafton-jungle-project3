import assert from "node:assert/strict";
import test from "node:test";
import type { MiniMapSnapshot } from "../src/game/domain/types";
import { exploredMarkers, fullMapScale, mapTransform, markerAtCanvasPoint, waypointMarkerState, waypointTravelRequest } from "../src/features/game/RoomMiniMap";

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

test("player-following minimap defaults to a wider tactical view", () => {
  const snapshot = minimap();
  const fullScale = fullMapScale(320, 240, snapshot);
  const transform = mapTransform(320, 240, snapshot, { x: 4_000, y: 6_000 });
  assert.ok(transform.scale <= fullScale * 2.75 + Number.EPSILON);
  assert.ok(transform.scale < fullScale * 4, "the previous close follow zoom is no longer used");
});

test("minimap transform falls back safely for malformed transient geometry", () => {
  const snapshot = minimap(0, Number.NaN);
  const transform = mapTransform(0, 0, snapshot, { x: 0, y: 0 }, { zoom: -2, centerX: null, centerY: null });
  assert.ok(Number.isFinite(transform.scale));
  assert.ok(transform.scale > 0);
});

test("minimap markers stay hidden until their room cell is explored", () => {
  const snapshot = minimap(640, 640);
  snapshot.geometry.columns = 1;
  snapshot.geometry.rows = 1;
  snapshot.geometry.cellSize = 640;
  snapshot.geometry.surfaces = [{ id: "room", points: [{ x: -2_000, y: -3_000 }, { x: -1_360, y: -3_000 }, { x: -1_360, y: -2_360 }, { x: -2_000, y: -2_360 }] }];
  snapshot.geometry.markers = [{ id: "resource", roomId: "room-1", kind: "resource", label: "자원 방", x: -1_680, y: -2_680, areaId: "official-map", active: true }];
  assert.deepEqual(exploredMarkers(snapshot), []);
  snapshot.explorationMask[0] = 1;
  assert.deepEqual(exploredMarkers(snapshot).map((marker) => marker.id), ["resource"]);
});

test("click hit testing selects only a nearby visible marker", () => {
  const snapshot = minimap(640, 640);
  const transform = mapTransform(320, 320, snapshot, null);
  const marker = { id: "waypoint", roomId: "room-1", kind: "waypoint" as const, label: "웨이포인트", x: -1_680, y: -2_680, areaId: "official-map", active: true };
  const point = transform.toCanvas(marker.x, marker.y);
  assert.equal(markerAtCanvasPoint([marker], point.x + 5, point.y + 4, transform)?.id, marker.id);
  assert.equal(markerAtCanvasPoint([marker], point.x + 30, point.y, transform), null);
});

test("waypoint marker travel requires the player to stand on a different active waypoint", () => {
  const marker = { id: "waypoint:destination", roomId: "room-2", kind: "waypoint" as const, label: "목적지", x: 0, y: 0, areaId: "official-map", active: true };
  const waypoint = { nearby: true, id: "waypoint:source", label: "출발지", destinationLabel: "", destinationId: "", holdProgress: 0, requiredPlayers: 1, presentPlayers: 1 };
  assert.equal(waypointMarkerState(marker, { ...waypoint, nearby: false, id: null }, null), "unavailable");
  assert.equal(waypointMarkerState({ ...marker, id: waypoint.id }, waypoint, null), "current");
  assert.equal(waypointMarkerState(marker, waypoint, null, marker.roomId), "current");
  assert.equal(waypointMarkerState(marker, waypoint, null), "ready");
  assert.equal(waypointMarkerState(marker, { ...waypoint, holdProgress: 0.5 }, marker.id), "traveling");
  assert.deepEqual(waypointTravelRequest(marker, waypoint), { sourceId: waypoint.id, destinationId: marker.id });
  assert.equal(waypointTravelRequest(marker, waypoint, marker.roomId), null);
});
