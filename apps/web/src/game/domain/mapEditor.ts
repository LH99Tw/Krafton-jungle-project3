import { buildEditorGeometry, type EditorMapGeometry } from "./editorGeometry";

export const EDITOR_MAP_STORAGE_KEY = "five-days:local-map:v1";
export const EDITOR_MIN_COORDINATE = -128;
export const EDITOR_MAX_COORDINATE = 127;
const EDITOR_MIN_ROOM_WIDTH = 2;
const EDITOR_MAX_ROOM_WIDTH = 6;
const EDITOR_MIN_ROOM_HEIGHT = 2;
const EDITOR_MAX_ROOM_HEIGHT = 5;

const EDITOR_ROOM_TYPES = ["start", "empty", "resource", "static-monster", "hidden-monster", "gate", "boss"] as const;
const EDITOR_ASSET_THEMES = ["forest", "marsh", "wastes"] as const;
const EDITOR_PORT_SIDES = ["north", "east", "south", "west"] as const;

export type EditorRoomType = "start" | "empty" | "resource" | "static-monster" | "hidden-monster" | "gate" | "boss";
export type EditorAssetTheme = "forest" | "marsh" | "wastes";
type EditorPortSide = "north" | "east" | "south" | "west";
export type EditorConnectionPort = { side: EditorPortSide; offset: number };

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
  /** Optional for backwards compatibility with maps saved before custom doors. */
  fromPort?: EditorConnectionPort;
  /** Optional for backwards compatibility with maps saved before custom doors. */
  toPort?: EditorConnectionPort;
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

export function validateEditorMap(map: EditorMapDefinition, geometry?: EditorMapGeometry): string[] {
  const failures: string[] = [];
  if (!map.title.trim()) failures.push("맵 이름을 입력해 주세요.");
  if (map.rooms.length < 2) failures.push("방을 두 개 이상 배치해 주세요.");
  if (map.rooms.filter((room) => room.type === "start").length !== 1) failures.push("시작 방은 정확히 하나여야 합니다.");
  if (map.rooms.filter((room) => room.type === "boss").length !== 1) failures.push("보스룸은 정확히 하나여야 합니다.");
  if (!map.rooms.some((room) => room.type === "gate")) failures.push("몬스터 게이트를 하나 이상 배치해 주세요.");
  const ids = new Set(map.rooms.map((room) => room.id));
  if (ids.size !== map.rooms.length) failures.push("방 ID가 중복되었습니다.");
  if (map.rooms.some((room) => !room.id.trim() || !room.name.trim())) failures.push("방 ID와 이름은 비워둘 수 없습니다.");
  if (map.rooms.some((room) => (
    !Number.isInteger(room.width)
    || room.width < EDITOR_MIN_ROOM_WIDTH
    || room.width > EDITOR_MAX_ROOM_WIDTH
    || !Number.isInteger(room.height)
    || room.height < EDITOR_MIN_ROOM_HEIGHT
    || room.height > EDITOR_MAX_ROOM_HEIGHT
  ))) failures.push(`방 크기는 가로 ${EDITOR_MIN_ROOM_WIDTH}..${EDITOR_MAX_ROOM_WIDTH}, 세로 ${EDITOR_MIN_ROOM_HEIGHT}..${EDITOR_MAX_ROOM_HEIGHT}의 정수여야 합니다.`);
  if (map.rooms.some((room) => (
    !Number.isInteger(room.x)
    || !Number.isInteger(room.y)
    || room.x < EDITOR_MIN_COORDINATE
    || room.y < EDITOR_MIN_COORDINATE
    || room.x + room.width - 1 > EDITOR_MAX_COORDINATE
    || room.y + room.height - 1 > EDITOR_MAX_COORDINATE
  ))) failures.push(`방 좌표는 크기를 포함해 ${EDITOR_MIN_COORDINATE}..${EDITOR_MAX_COORDINATE} 셀 안에 있어야 합니다.`);
  if (map.connections.some((connection) => connection.from === connection.to || !ids.has(connection.from) || !ids.has(connection.to))) {
    failures.push("유효하지 않은 통로가 있습니다.");
  }
  const connectionIds = map.connections.map((connection) => connection.id);
  if (connectionIds.some((id) => !id.trim())) failures.push("통로 ID는 비워둘 수 없습니다.");
  if (new Set(connectionIds).size !== connectionIds.length) failures.push("통로 ID가 중복되었습니다.");
  for (const connection of map.connections) {
    const from = map.rooms.find((room) => room.id === connection.from);
    const to = map.rooms.find((room) => room.id === connection.to);
    if (connection.fromPort && (!from || !isValidEditorPort(from, connection.fromPort))) failures.push(`통로 “${connection.id}”의 시작 출입구가 방 범위를 벗어났습니다.`);
    if (connection.toPort && (!to || !isValidEditorPort(to, connection.toPort))) failures.push(`통로 “${connection.id}”의 도착 출입구가 방 범위를 벗어났습니다.`);
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
  const dimensionsValid = !map.rooms.some((room) => (
    !Number.isInteger(room.width)
    || room.width < EDITOR_MIN_ROOM_WIDTH
    || room.width > EDITOR_MAX_ROOM_WIDTH
    || !Number.isInteger(room.height)
    || room.height < EDITOR_MIN_ROOM_HEIGHT
    || room.height > EDITOR_MAX_ROOM_HEIGHT
  ));
  if (dimensionsValid) failures.push(...(geometry ?? buildEditorGeometry(map, { cellWidth: 1, cellHeight: 1, corridorWidth: 0.5 })).errors);
  return failures;
}

export function isEditorMapDefinition(value: unknown): value is EditorMapDefinition {
  if (!value || typeof value !== "object") return false;
  const map = value as Partial<EditorMapDefinition>;
  if (map.version !== 1 || typeof map.title !== "string" || map.title.trim().length === 0 || map.title.length > 80) return false;
  if (!Array.isArray(map.rooms) || !Array.isArray(map.connections)) return false;
  return map.rooms.every(isEditorRoom) && map.connections.every(isEditorConnection);
}

function isEditorRoom(value: unknown): value is EditorRoom {
  if (!value || typeof value !== "object") return false;
  const room = value as Partial<EditorRoom>;
  return typeof room.id === "string" && room.id.trim().length > 0 && room.id.length <= 96
    && typeof room.name === "string" && room.name.trim().length > 0 && room.name.length <= 80
    && EDITOR_ROOM_TYPES.includes(room.type as EditorRoomType)
    && EDITOR_ASSET_THEMES.includes(room.asset as EditorAssetTheme)
    && Number.isInteger(room.x) && Number.isInteger(room.y)
    && room.x! >= EDITOR_MIN_COORDINATE && room.y! >= EDITOR_MIN_COORDINATE
    && Number.isInteger(room.width) && room.width! >= EDITOR_MIN_ROOM_WIDTH && room.width! <= EDITOR_MAX_ROOM_WIDTH
    && Number.isInteger(room.height) && room.height! >= EDITOR_MIN_ROOM_HEIGHT && room.height! <= EDITOR_MAX_ROOM_HEIGHT
    && room.x! + room.width! - 1 <= EDITOR_MAX_COORDINATE
    && room.y! + room.height! - 1 <= EDITOR_MAX_COORDINATE;
}

function isEditorConnection(value: unknown): value is EditorConnection {
  if (!value || typeof value !== "object") return false;
  const connection = value as Partial<EditorConnection>;
  return typeof connection.id === "string" && connection.id.trim().length > 0 && connection.id.length <= 96
    && typeof connection.from === "string" && connection.from.trim().length > 0 && connection.from.length <= 96
    && typeof connection.to === "string" && connection.to.trim().length > 0 && connection.to.length <= 96
    && (connection.fromPort === undefined || isEditorConnectionPort(connection.fromPort))
    && (connection.toPort === undefined || isEditorConnectionPort(connection.toPort));
}

function isEditorConnectionPort(value: unknown): value is EditorConnectionPort {
  if (!value || typeof value !== "object") return false;
  const port = value as Partial<EditorConnectionPort>;
  return EDITOR_PORT_SIDES.includes(port.side as EditorPortSide)
    && Number.isInteger(port.offset)
    && port.offset! >= 0;
}

export function cloneEditorMap(map: EditorMapDefinition): EditorMapDefinition {
  return {
    ...map,
    rooms: map.rooms.map((room) => ({ ...room })),
    connections: map.connections.map((connection) => ({
      ...connection,
      fromPort: connection.fromPort ? { ...connection.fromPort } : undefined,
      toPort: connection.toPort ? { ...connection.toPort } : undefined,
    })),
  };
}

function editorPortSpan(room: EditorRoom, side: EditorPortSide): number {
  return side === "north" || side === "south" ? room.width : room.height;
}

function isValidEditorPort(room: EditorRoom, port: EditorConnectionPort): boolean {
  return EDITOR_PORT_SIDES.includes(port.side)
    && Number.isInteger(port.offset)
    && port.offset >= 0
    && port.offset < editorPortSpan(room, port.side);
}

export function clampEditorPort(room: EditorRoom, port: EditorConnectionPort): EditorConnectionPort {
  return {
    side: port.side,
    offset: Math.max(0, Math.min(editorPortSpan(room, port.side) - 1, Math.round(port.offset))),
  };
}

export function editorThemeZone(theme: EditorAssetTheme): 1 | 2 | 3 {
  return theme === "marsh" ? 2 : theme === "wastes" ? 3 : 1;
}
