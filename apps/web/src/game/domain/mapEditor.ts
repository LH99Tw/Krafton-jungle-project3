import { buildEditorGeometry } from "./editorGeometry";

export const EDITOR_MAP_STORAGE_KEY = "five-days:local-map:v1";

export type EditorRoomType = "start" | "empty" | "resource" | "static-monster" | "gate" | "boss";
export type EditorAssetTheme = "forest" | "marsh" | "wastes";

export type EditorRoom = {
  id: string;
  name: string;
  type: EditorRoomType;
  asset: EditorAssetTheme;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type EditorConnection = {
  id: string;
  from: string;
  to: string;
};

export type EditorMapDefinition = {
  version: 1;
  title: string;
  rooms: EditorRoom[];
  connections: EditorConnection[];
};

export const DEFAULT_EDITOR_MAP: EditorMapDefinition = {
  version: 1,
  title: "마왕성으로 가는 길",
  rooms: [
    { id: "room-base", name: "원정대 야영지", type: "start", asset: "forest", x: 1, y: 7, width: 3, height: 3 },
    { id: "room-forest", name: "녹음의 사냥터", type: "static-monster", asset: "forest", x: 5, y: 7, width: 3, height: 3 },
    { id: "room-marsh", name: "침수된 채집지", type: "resource", asset: "marsh", x: 9, y: 5, width: 3, height: 3 },
    { id: "room-gate", name: "균열 관문", type: "gate", asset: "marsh", x: 13, y: 5, width: 2, height: 3 },
    { id: "room-wastes", name: "황폐한 전초기지", type: "static-monster", asset: "wastes", x: 16, y: 3, width: 3, height: 3 },
    { id: "room-boss", name: "마왕의 제단", type: "boss", asset: "wastes", x: 20, y: 2, width: 4, height: 4 },
  ],
  connections: [
    { id: "path-base-forest", from: "room-base", to: "room-forest" },
    { id: "path-forest-marsh", from: "room-forest", to: "room-marsh" },
    { id: "path-marsh-gate", from: "room-marsh", to: "room-gate" },
    { id: "path-gate-wastes", from: "room-gate", to: "room-wastes" },
    { id: "path-wastes-boss", from: "room-wastes", to: "room-boss" },
  ],
};

export function validateEditorMap(map: EditorMapDefinition): string[] {
  const failures: string[] = [];
  if (map.rooms.length < 2) failures.push("방을 두 개 이상 배치해 주세요.");
  if (map.rooms.filter((room) => room.type === "start").length !== 1) failures.push("시작 방은 정확히 하나여야 합니다.");
  if (map.rooms.filter((room) => room.type === "boss").length !== 1) failures.push("보스룸은 정확히 하나여야 합니다.");
  if (!map.rooms.some((room) => room.type === "gate")) failures.push("몬스터 게이트를 하나 이상 배치해 주세요.");
  const ids = new Set(map.rooms.map((room) => room.id));
  if (ids.size !== map.rooms.length) failures.push("방 ID가 중복되었습니다.");
  if (map.connections.some((connection) => connection.from === connection.to || !ids.has(connection.from) || !ids.has(connection.to))) {
    failures.push("유효하지 않은 통로가 있습니다.");
  }
  const connectionPairs = map.connections.map((connection) => [connection.from, connection.to].sort().join("|"));
  if (new Set(connectionPairs).size !== connectionPairs.length) failures.push("같은 두 방을 잇는 중복 통로가 있습니다.");
  const start = map.rooms.find((room) => room.type === "start");
  if (start) {
    const graph = new Map(map.rooms.map((room) => [room.id, [] as string[]]));
    for (const connection of map.connections) {
      graph.get(connection.from)?.push(connection.to);
      graph.get(connection.to)?.push(connection.from);
    }
    const visited = new Set([start.id]);
    const queue = [start.id];
    while (queue.length > 0) {
      for (const next of graph.get(queue.shift() as string) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    if (visited.size !== map.rooms.length) failures.push("모든 방이 시작 방과 통로로 연결되어야 합니다.");
  }
  failures.push(...buildEditorGeometry(map, { cellWidth: 1, cellHeight: 1, corridorWidth: 0.5 }).errors);
  return failures;
}

export function cloneEditorMap(map: EditorMapDefinition): EditorMapDefinition {
  return {
    ...map,
    rooms: map.rooms.map((room) => ({ ...room })),
    connections: map.connections.map((connection) => ({ ...connection })),
  };
}

export function editorThemeZone(theme: EditorAssetTheme): 1 | 2 | 3 {
  return theme === "marsh" ? 2 : theme === "wastes" ? 3 : 1;
}
