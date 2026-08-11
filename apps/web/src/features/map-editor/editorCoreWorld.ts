import { boundsOf, type AuthoredRoomId, type CoreRoomKind, type CoreWorldDefinition, type WorldRect } from "@five-days/game-core";
import { buildEditorGeometry } from "../../game/domain/editorGeometry";
import { editorThemeZone, type EditorMapDefinition, type EditorRoomType } from "../../game/domain/mapEditor";
import { EDITOR_CELL_HEIGHT, EDITOR_CELL_WIDTH, EDITOR_CORRIDOR_SIZE } from "../../game/runtime/room/layout";

export function editorCoreRoomId(roomId: string): AuthoredRoomId {
  return `editor:${roomId}`;
}

export function buildEditorCoreWorld(map: EditorMapDefinition): CoreWorldDefinition {
  const geometry = buildEditorGeometry(map, {
    cellWidth: EDITOR_CELL_WIDTH,
    cellHeight: EDITOR_CELL_HEIGHT,
    corridorWidth: EDITOR_CORRIDOR_SIZE,
  });
  if (geometry.errors.length > 0) throw new Error(geometry.errors.join(" "));
  const contentBounds = boundsOf(geometry.floorRects);
  const offsetX = EDITOR_CELL_WIDTH - contentBounds.x;
  const offsetY = EDITOR_CELL_HEIGHT - contentBounds.y;
  const translateRect = (rect: WorldRect): WorldRect => ({ ...rect, x: rect.x + offsetX, y: rect.y + offsetY });
  const translatePoint = (point: Readonly<{ x: number; y: number }>) => ({ x: point.x + offsetX, y: point.y + offsetY });
  const base = map.rooms.find((room) => room.type === "start");
  const boss = map.rooms.find((room) => room.type === "boss");
  if (!base || !boss) throw new Error("편집 맵에는 시작 방과 보스룸이 각각 하나씩 필요합니다.");
  const depth = roomDepths(map, base.id);
  const connections = map.connections.map((connection) => {
    const route = geometry.routes.find((candidate) => candidate.connectionId === connection.id);
    if (!route) throw new Error(`통로 ${connection.id}의 지형을 만들 수 없습니다.`);
    const points = route.points.map(translatePoint);
    return {
      id: connection.id,
      from: editorCoreRoomId(connection.from),
      to: editorCoreRoomId(connection.to),
      floorRects: route.floorRects.map(translateRect),
      points,
      portal: points[Math.floor(points.length / 2)] ?? points[0]!,
    };
  });
  const rooms = map.rooms.map((room) => ({
    id: editorCoreRoomId(room.id),
    zone: editorThemeZone(room.asset),
    kind: coreRoomKind(room.type),
    rect: translateRect(geometry.roomRects.get(room.id)!),
    mapX: room.x,
    mapY: room.y,
    connections: map.connections
      .filter((connection) => connection.from === room.id || connection.to === room.id)
      .map((connection) => editorCoreRoomId(connection.from === room.id ? connection.to : connection.from)),
    depth: depth.get(room.id) ?? 0,
  }));
  const walkable = [...rooms.map((room) => room.rect), ...connections.flatMap((connection) => connection.floorRects)];
  const translatedBounds = boundsOf(walkable);
  return {
    kind: "authored",
    id: `editor:${map.title}`,
    rooms,
    connections,
    walkable,
    bounds: {
      x: 0,
      y: 0,
      width: translatedBounds.x + translatedBounds.width + EDITOR_CELL_WIDTH,
      height: translatedBounds.y + translatedBounds.height + EDITOR_CELL_HEIGHT,
    },
    baseRoomId: editorCoreRoomId(base.id),
    bossRoomId: editorCoreRoomId(boss.id),
    gateRoomIds: map.rooms.filter((room) => room.type === "gate").map((room) => editorCoreRoomId(room.id)),
  };
}

function coreRoomKind(type: EditorRoomType): CoreRoomKind {
  return type;
}

function roomDepths(map: EditorMapDefinition, startId: string): Map<string, number> {
  const graph = new Map(map.rooms.map((room) => [room.id, [] as string[]]));
  for (const connection of map.connections) {
    graph.get(connection.from)?.push(connection.to);
    graph.get(connection.to)?.push(connection.from);
  }
  const result = new Map<string, number>([[startId, 0]]);
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of graph.get(current) ?? []) {
      if (result.has(next)) continue;
      result.set(next, (result.get(current) ?? 0) + 1);
      queue.push(next);
    }
  }
  return result;
}
