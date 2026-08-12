import { boundsOf, type AuthoredRoomId, type CoreRoomKind, type CoreWorldDefinition, type WorldRect } from "@five-days/game-core";
import { buildEditorGeometry, type EditorJoinGeometry, type EditorRouteGeometry } from "../../game/domain/editorGeometry";
import { editorRoomJoins, editorThemeZone, type EditorMapDefinition, type EditorRoomType } from "../../game/domain/mapEditor";
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
  const joins = editorRoomJoins(map);
  const effectiveConnections = [
    ...map.connections.map((connection) => {
      const join = geometry.joins.find((candidate) => candidate.connectionId === connection.id);
      return { id: connection.id, from: connection.from, to: connection.to, route: join ? null : geometry.routes.find((candidate) => candidate.connectionId === connection.id) ?? null, join };
    }),
    ...joins.filter((join) => !map.connections.some((connection) => connection.id === join.connectionId))
      .map((join) => ({ id: join.connectionId, from: join.from, to: join.to, route: null, join: geometry.joins.find((candidate) => candidate.connectionId === join.connectionId) })),
  ];
  const depth = roomDepths(map, base.id);
  const connections = effectiveConnections.map((connection) => {
    const source = connection.route ?? connection.join;
    if (!source) throw new Error(`통로 ${connection.id}의 지형을 만들 수 없습니다.`);
    const points = source.points.map(translatePoint);
    const floorRects = connection.route?.floorRects.map(translateRect) ?? [];
    const lockBarrier = translateRect(connection.route ? routeBarrier(connection.route) : joinBarrier(connection.join!));
    const trapRoom = map.rooms.find((room) => (room.id === connection.from || room.id === connection.to) && room.type === "trap");
    const trapBarrier = trapRoom ? doorwayBarrier(
      translateRect(geometry.roomRects.get(trapRoom.id)!),
      trapRoom.id === connection.from ? points[0]! : points.at(-1)!,
      floorRects,
      connection.join ? translateRect(connection.join.opening) : undefined,
    ) : undefined;
    return {
      id: connection.id,
      from: editorCoreRoomId(connection.from),
      to: editorCoreRoomId(connection.to),
      floorRects,
      points,
      portal: points[Math.floor(points.length / 2)] ?? points[0]!,
      lockBarrier,
      trapBarrier,
    };
  });
  const rooms = map.rooms.map((room) => ({
    id: editorCoreRoomId(room.id),
    zone: editorThemeZone(room.asset),
    kind: coreRoomKind(room.type),
    rect: translateRect(geometry.roomRects.get(room.id)!),
    mapX: room.x,
    mapY: room.y,
    connections: effectiveConnections
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
    gateCandidateRoomIds: map.rooms.filter((room) => room.type === "gate-candidate").map((room) => editorCoreRoomId(room.id)),
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
  for (const join of editorRoomJoins(map)) {
    graph.get(join.from)?.push(join.to);
    graph.get(join.to)?.push(join.from);
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

function routeBarrier(route: EditorRouteGeometry): WorldRect {
  let best = { from: route.points[0]!, to: route.points[1] ?? route.points[0]!, length: -1 };
  for (let index = 1; index < route.points.length; index += 1) {
    const from = route.points[index - 1]!;
    const to = route.points[index]!;
    const length = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
    if (length > best.length) best = { from, to, length };
  }
  const horizontal = best.from.y === best.to.y;
  const matching = route.floorRects.find((rect) => horizontal ? rect.width >= best.length : rect.height >= best.length) ?? route.floorRects[0]!;
  const centerX = (best.from.x + best.to.x) / 2;
  const centerY = (best.from.y + best.to.y) / 2;
  return horizontal
    ? { x: centerX - 9, y: centerY - matching.height / 2, width: 18, height: matching.height }
    : { x: centerX - matching.width / 2, y: centerY - 9, width: matching.width, height: 18 };
}

function joinBarrier(join: EditorJoinGeometry): WorldRect {
  return join.axis === "vertical"
    ? { x: join.opening.x + join.opening.width / 2 - 9, y: join.opening.y, width: 18, height: join.opening.height }
    : { x: join.opening.x, y: join.opening.y + join.opening.height / 2 - 9, width: join.opening.width, height: 18 };
}

function doorwayBarrier(room: WorldRect, door: Readonly<{ x: number; y: number }>, floors: readonly WorldRect[], opening?: WorldRect): WorldRect {
  if (opening) return opening.width >= opening.height
    ? { x: opening.x, y: opening.y + opening.height / 2 - 9, width: opening.width, height: 18 }
    : { x: opening.x + opening.width / 2 - 9, y: opening.y, width: 18, height: opening.height };
  const horizontalEdge = Math.min(Math.abs(door.y - room.y), Math.abs(door.y - (room.y + room.height)))
    <= Math.min(Math.abs(door.x - room.x), Math.abs(door.x - (room.x + room.width)));
  const floor = floors.find((rect) => door.x >= rect.x - 1 && door.x <= rect.x + rect.width + 1 && door.y >= rect.y - 1 && door.y <= rect.y + rect.height + 1);
  const span = horizontalEdge ? floor?.width ?? 180 : floor?.height ?? 180;
  return horizontalEdge
    ? { x: door.x - span / 2, y: door.y - 9, width: span, height: 18 }
    : { x: door.x - 9, y: door.y - span / 2, width: 18, height: span };
}
