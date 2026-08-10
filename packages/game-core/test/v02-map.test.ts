import assert from "node:assert/strict";
import test from "node:test";
import {
  GATE_POSITION,
  ROOMS_PER_ZONE,
  START_POSITION,
  ZONE_GRID_SIZE,
  generateThreeZoneMap,
  generateZoneMap,
  roomAt,
  validateZoneMap,
  type RoomType,
} from "../src/v02/map";

const EXPECTED_COUNTS: Readonly<Record<RoomType, number>> = {
  start: 1,
  gate: 1,
  resource: 4,
  "static-monster": 4,
  empty: 2,
  "central-waypoint": 1,
  "hidden-monster": 2,
};

test("uses the documented screen-coordinate anchors and room counts", () => {
  const map = generateZoneMap("anchors", 1);
  assert.equal(ZONE_GRID_SIZE, 5);
  assert.equal(ROOMS_PER_ZONE, 15);
  assert.equal(roomAt(map, START_POSITION)?.type, "start");
  assert.equal(roomAt(map, GATE_POSITION)?.type, "gate");

  const counts = Object.fromEntries(
    Object.keys(EXPECTED_COUNTS).map((type) => [type, map.rooms.filter((room) => room.type === type).length]),
  );
  assert.deepEqual(counts, EXPECTED_COUNTS);
});

test("is deterministic and derives three distinct zone layouts", () => {
  const first = generateThreeZoneMap("same-run-seed");
  const second = generateThreeZoneMap("same-run-seed");
  assert.deepEqual(first, second);
  assert.deepEqual(first.zones.map((zone) => zone.zone), [1, 2, 3]);

  const signatures = new Set(first.zones.map(layoutSignature));
  assert.ok(signatures.size >= 2, "the zone number must participate in layout generation");
});

test("zone 1 start always has fixed right and up connections", () => {
  for (let seed = 0; seed < 500; seed += 1) {
    const map = generateZoneMap(`fixed-start-${seed}`, 1);
    const start = roomAt(map, START_POSITION);
    const right = roomAt(map, { x: 1, y: 4 });
    const up = roomAt(map, { x: 0, y: 3 });
    assert.ok(start && right && up);
    assert.ok(start.connections.includes(right.id));
    assert.ok(start.connections.includes(up.id));
  }
});

test("property: 1,000 run seeds satisfy every 0.2 map invariant", () => {
  const layoutDiversity = new Set<string>();
  for (let seed = 0; seed < 1_000; seed += 1) {
    const world = generateThreeZoneMap(`property-${seed}`);
    assert.equal(world.zones.length, 3);
    for (const zone of world.zones) {
      assert.deepEqual(validateZoneMap(zone), [], `invalid seed property-${seed}, zone ${zone.zone}`);
      assert.equal(new Set(zone.rooms.map((room) => `${room.x},${room.y}`)).size, ROOMS_PER_ZONE);
      assert.ok(zone.rooms.every((room) => room.connections.length >= 1));

      const hidden = zone.rooms.filter((room) => room.type === "hidden-monster");
      assert.equal(hidden.length, 2);
      assert.ok(hidden.every((room) => room.connections.length === 1));
      const depths = zone.rooms
        .filter((room) => room.type !== "start" && room.type !== "gate")
        .map((room) => room.depthScore)
        .sort((left, right) => right - left);
      assert.ok(hidden.every((room) => room.depthScore >= (depths[1] as number)));

      const waypoint = zone.rooms.find((room) => room.type === "central-waypoint");
      assert.ok(waypoint);
      assert.ok(Math.abs(waypoint.x - START_POSITION.x) + Math.abs(waypoint.y - START_POSITION.y) > 1);
      assert.ok(Math.abs(waypoint.x - GATE_POSITION.x) + Math.abs(waypoint.y - GATE_POSITION.y) > 1);
      layoutDiversity.add(layoutSignature(zone));
    }
  }
  assert.ok(layoutDiversity.size > 100, `expected procedural diversity, received ${layoutDiversity.size} layouts`);
});

function layoutSignature(zone: ReturnType<typeof generateZoneMap>): string {
  return zone.rooms.map((room) => `${room.x},${room.y}:${room.type}`).join("|");
}
