import type { CoreWorldConnectionDefinition, CoreWorldDefinition } from "./simulation";
import type { WorldRect } from "./world";

export type AuthoredRoomType = "start" | "empty" | "resource" | "static-monster" | "hidden-monster" | "gate" | "boss";
export type AuthoredAssetTheme = "forest" | "marsh" | "wastes";
export type AuthoredPortSide = "north" | "east" | "south" | "west";
export type AuthoredConnectionPort = Readonly<{ side: AuthoredPortSide; offset: number }>;
export type AuthoredMapDefinition = Readonly<{
  version: 1;
  title: string;
  rooms: readonly Readonly<{
    id: string;
    name: string;
    type: AuthoredRoomType;
    asset: AuthoredAssetTheme;
    x: number;
    y: number;
    width: number;
    height: number;
  }>[];
  connections: readonly Readonly<{
    id: string;
    from: string;
    to: string;
    fromPort?: AuthoredConnectionPort;
    toPort?: AuthoredConnectionPort;
  }>[];
}>;

export type OfficialMapManifest = Readonly<{
  schemaVersion: 1;
  mapRevision: string;
  map: AuthoredMapDefinition;
  /** Precompiled authoritative world so the game server never imports editor UI code. */
  world: CoreWorldDefinition;
}>;

const map = {
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
} as const satisfies AuthoredMapDefinition;

const rooms = [
  { id: "editor:room-base", zone: 1, kind: "start", rect: { x: 320, y: 1320, width: 960, height: 660 }, mapX: 1, mapY: 7, connections: ["editor:room-forest"], depth: 0 },
  { id: "editor:room-forest", zone: 1, kind: "static-monster", rect: { x: 1600, y: 1320, width: 960, height: 660 }, mapX: 5, mapY: 7, connections: ["editor:room-base", "editor:room-marsh"], depth: 1 },
  { id: "editor:room-marsh", zone: 2, kind: "resource", rect: { x: 2880, y: 880, width: 960, height: 660 }, mapX: 9, mapY: 5, connections: ["editor:room-forest", "editor:room-gate"], depth: 2 },
  { id: "editor:room-gate", zone: 2, kind: "gate", rect: { x: 4160, y: 880, width: 640, height: 660 }, mapX: 13, mapY: 5, connections: ["editor:room-marsh", "editor:room-wastes"], depth: 3 },
  { id: "editor:room-wastes", zone: 3, kind: "static-monster", rect: { x: 5120, y: 440, width: 960, height: 660 }, mapX: 16, mapY: 3, connections: ["editor:room-gate", "editor:room-boss"], depth: 4 },
  { id: "editor:room-boss", zone: 3, kind: "boss", rect: { x: 6400, y: 220, width: 1280, height: 880 }, mapX: 20, mapY: 2, connections: ["editor:room-wastes"], depth: 5 },
] as const;

const connections: readonly CoreWorldConnectionDefinition[] = [
  { id: "path-base-forest", from: "editor:room-base", to: "editor:room-forest", floorRects: [{ x: 1190, y: 1560, width: 500, height: 180 }], points: [{ x: 1280, y: 1650 }, { x: 1600, y: 1650 }], portal: { x: 1600, y: 1650 } },
  { id: "path-forest-marsh", from: "editor:room-forest", to: "editor:room-marsh", floorRects: [{ x: 1990, y: 1120, width: 180, height: 290 }, { x: 1990, y: 1120, width: 980, height: 180 }], points: [{ x: 2080, y: 1320 }, { x: 2080, y: 1210 }, { x: 2880, y: 1210 }], portal: { x: 2080, y: 1210 } },
  { id: "path-marsh-gate", from: "editor:room-marsh", to: "editor:room-gate", floorRects: [{ x: 3750, y: 1120, width: 500, height: 180 }], points: [{ x: 3840, y: 1210 }, { x: 4160, y: 1210 }], portal: { x: 4160, y: 1210 } },
  { id: "path-gate-wastes", from: "editor:room-gate", to: "editor:room-wastes", floorRects: [{ x: 4550, y: 680, width: 180, height: 290 }, { x: 4550, y: 680, width: 660, height: 180 }], points: [{ x: 4640, y: 880 }, { x: 4640, y: 770 }, { x: 5120, y: 770 }], portal: { x: 4640, y: 770 } },
  { id: "path-wastes-boss", from: "editor:room-wastes", to: "editor:room-boss", floorRects: [{ x: 5990, y: 680, width: 500, height: 180 }], points: [{ x: 6080, y: 770 }, { x: 6400, y: 770 }], portal: { x: 6400, y: 770 } },
] as const;

const walkable: readonly WorldRect[] = [...rooms.map((room) => room.rect), ...connections.flatMap((connection) => connection.floorRects)];

export const OFFICIAL_MAP_MANIFEST: OfficialMapManifest = {
  schemaVersion: 1,
  mapRevision: "6ccf02d7f0442e54f86be7eceab7b4da82f324d596bafdbed5c30ece5ca6cda5",
  map,
  world: {
    kind: "authored",
    id: "official-map",
    rooms,
    connections,
    walkable,
    bounds: { x: 0, y: 0, width: 8000, height: 2200 },
    baseRoomId: "editor:room-base",
    bossRoomId: "editor:room-boss",
    gateRoomIds: ["editor:room-gate"],
  },
};

export const OFFICIAL_WORLD = OFFICIAL_MAP_MANIFEST.world;
