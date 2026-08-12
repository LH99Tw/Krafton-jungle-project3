import type { EditorConnection, EditorMapDefinition, EditorRoom, EditorRoomType } from "../src/game/domain/mapEditor";

const THEMES = { 1: "forest", 2: "marsh", 3: "wastes" } as const;
const ZONE_TOP = { 1: 56, 2: 28, 3: 0 } as const;
const ROWS = [
  { y: 0, height: 2, x: -4, widths: [3, 5] },
  { y: 2, height: 3, x: -6, widths: [2, 3, 4, 3] },
  { y: 5, height: 2, x: -8, widths: [2, 3, 2, 3, 3, 3] },
  { y: 7, height: 3, x: -10, widths: [3, 2, 3, 2, 4, 3, 3] },
  { y: 10, height: 2, x: -10, widths: [2, 4, 3, 3, 2, 4, 2] },
  { y: 12, height: 3, x: -8, widths: [2, 3, 4, 2, 3, 2] },
  { y: 15, height: 2, x: -6, widths: [3, 4, 2, 3] },
  { y: 17, height: 3, x: -4, widths: [4, 4] },
] as const;

const CANDIDATES = new Set([2, 6, 10, 14, 18, 22, 26, 31, 35]);
const HIDDEN = new Set([5, 13, 24, 33]);
const TRAPS = new Set([11, 28]);

export function createVerticalHexMap(): EditorMapDefinition {
  const rooms: EditorRoom[] = [];
  const connections: EditorConnection[] = [];

  for (const zone of [1, 2, 3] as const) {
    let index = 0;
    for (const row of ROWS) {
      let x = row.x;
      for (const width of row.widths) {
        const id = roomId(zone, index);
        const type = roomType(zone, index);
        rooms.push({
          id,
          name: roomName(zone, index, type),
          type,
          asset: THEMES[zone],
          x,
          y: ZONE_TOP[zone] + row.y,
          width,
          height: row.height,
        });
        x += width;
        index += 1;
      }
    }

    const goldId = `z${zone}-secret-gold`;
    rooms.push({ id: goldId, name: `${zone}구역 봉인된 황금 금고`, type: "gold", asset: THEMES[zone], x: -17, y: ZONE_TOP[zone] + 8, width: 3, height: 3 });
    connections.push({ id: `secret-z${zone}-gold`, from: roomId(zone, 12), to: goldId, fromPort: { side: "west", offset: 1 }, toPort: { side: "east", offset: 1 }, width: 1 });

    if (zone === 2) {
      rooms.push({ id: "z2-secret-altar", name: "핏빛 계약의 비밀 제단", type: "altar", asset: "marsh", x: 14, y: ZONE_TOP[zone] + 8, width: 3, height: 3 });
      connections.push({ id: "secret-z2-altar", from: roomId(2, 18), to: "z2-secret-altar", fromPort: { side: "east", offset: 1 }, toPort: { side: "west", offset: 1 }, width: 1 });
    }
  }

  rooms.push({ id: "room-boss", name: "마왕의 옥좌", type: "boss", asset: "wastes", x: -3, y: -10, width: 6, height: 5 });
  connections.push(
    transition("transition-z1-z2", roomId(1, 0), roomId(2, 37)),
    transition("transition-z2-z3", roomId(2, 0), roomId(3, 37)),
    { id: "transition-z3-boss", from: roomId(3, 0), to: "room-boss", fromPort: { side: "north", offset: 1 }, toPort: { side: "south", offset: 2 }, width: 2 },
  );
  return { version: 1, title: "세 개의 수직 육각 전장", rooms, connections };
}

function transition(id: string, from: string, to: string): EditorConnection {
  return { id, from, to, fromPort: { side: "north", offset: 1 }, toPort: { side: "south", offset: 1 }, width: 2 };
}

function roomId(zone: number, index: number): string {
  return `z${zone}-hex-${String(index + 1).padStart(2, "0")}`;
}

function roomType(zone: 1 | 2 | 3, index: number): EditorRoomType {
  if (zone === 1 && index === 36) return "start";
  if (index === 37) return "checkpoint";
  if (CANDIDATES.has(index)) return "gate-candidate";
  if (HIDDEN.has(index)) return "hidden-monster";
  if (TRAPS.has(index)) return "trap";
  if (index === 20) return "shrine";
  if (index === 16) return "gamble";
  if (index === 8) return "shop";
  if (index === 30) return "resource";
  if (index === 36 || (zone === 1 && index === 34)) return "empty";
  return "static-monster";
}

function roomName(zone: number, index: number, type: EditorRoomType): string {
  const names: Partial<Record<EditorRoomType, string>> = {
    start: "원정대 최하단 야영지",
    checkpoint: `${zone}구역 귀환석`,
    "gate-candidate": `${zone}구역 불안정 균열 후보`,
    "hidden-monster": `${zone}구역 은폐 괴수 소굴`,
    trap: `${zone}구역 봉쇄 함정`,
    shrine: `${zone}구역 메아리 성소`,
    gamble: `${zone}구역 운명의 도박장`,
    shop: `${zone}구역 원정 상점`,
    resource: `${zone}구역 자원 채집지`,
    empty: `${zone}구역 연결 광장`,
    "static-monster": `${zone}구역 괴수 전장`,
  };
  return `${names[type] ?? `${zone}구역 전장`} ${index + 1}`;
}
