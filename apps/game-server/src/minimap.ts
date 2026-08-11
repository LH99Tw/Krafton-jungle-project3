import {
  BOSS_ROOM_ID,
  OFFICIAL_MAP_MANIFEST,
  boundarySegments,
  boundsOf,
  buildWorldFromRooms,
  createExplorationMask,
  createMiniMapGrid,
  createWallSpatialIndex,
  encodeCellRanges,
  encodeMask,
  rectToMiniMapSurface,
  revealAround,
  type GameCore,
  type WallSpatialIndex,
  type WorldRect,
} from "@five-days/game-core";
import { PLAYER_VISION_RADIUS, PROTOCOL_VERSION, type MiniMapDelta, type MiniMapGeometry, type MiniMapInit } from "@five-days/protocol";

type AreaState = {
  geometry: MiniMapGeometry;
  wallIndex: WallSpatialIndex;
  mask: Uint8Array;
  pending: Set<number>;
  revision: number;
};

const OFFICIAL_AREA_ID = "official-map";
const EXPLORATION_MOVE_THRESHOLD = 4;

export class PartyExploration {
  private readonly areas = new Map<string, AreaState>();
  private readonly lastRevealPosition = new Map<string, { areaId: string; x: number; y: number }>();
  private markerSignature = "";
  private geometryDirty = false;

  constructor(private readonly core: GameCore) {
    const authored = core.options.world;
    if (authored) {
      this.addArea(
        OFFICIAL_AREA_ID,
        authored.walkable,
        authored.bounds,
        authored.id === OFFICIAL_AREA_ID ? OFFICIAL_MAP_MANIFEST.mapRevision : `${authored.id}:v1`,
      );
    } else {
      for (const zone of core.maps.zones) {
        const rooms = [...core.rooms.values()].filter((room) => room.zone === zone.zone && room.id !== BOSS_ROOM_ID);
        const world = buildWorldFromRooms(rooms, zone.zone === 3);
        this.addArea(`zone-${zone.zone}`, world.rects, boundsOf(world.rects), `${core.options.seed}:zone-${zone.zone}`);
      }
    }
    this.refreshMarkers();
  }

  areaIdForRoom(roomId: string): string | null {
    if (this.core.options.world) return this.core.rooms.has(roomId as never) ? OFFICIAL_AREA_ID : null;
    const room = this.core.rooms.get(roomId as never);
    return room ? `zone-${room.zone}` : roomId === BOSS_ROOM_ID ? "zone-3" : null;
  }

  update(): void {
    this.refreshMarkers();
    const activePlayers = new Set<string>();
    for (const player of this.core.players.values()) {
      if (!player.connected || !player.alive) continue;
      activePlayers.add(player.userId);
      const areaId = this.areaIdForRoom(player.roomId);
      const state = areaId ? this.areas.get(areaId) : undefined;
      if (!state || !areaId) continue;
      const previous = this.lastRevealPosition.get(player.userId);
      if (previous?.areaId === areaId && Math.hypot(player.x - previous.x, player.y - previous.y) < EXPLORATION_MOVE_THRESHOLD) continue;
      this.lastRevealPosition.set(player.userId, { areaId, x: player.x, y: player.y });
      for (const index of revealAround(
        state.geometry,
        state.mask,
        player.x,
        player.y,
        state.geometry.visionRadius,
        state.wallIndex,
      )) state.pending.add(index);
    }
    for (const userId of this.lastRevealPosition.keys()) {
      if (!activePlayers.has(userId)) this.lastRevealPosition.delete(userId);
    }
  }

  init(areaId: string): MiniMapInit | null {
    const state = this.areas.get(areaId);
    if (!state) return null;
    return { v: PROTOCOL_VERSION, geometry: state.geometry, revision: state.revision, explorationMask: encodeMask(state.mask) };
  }

  allInit(): MiniMapInit[] {
    return [...this.areas.keys()].map((areaId) => this.init(areaId)).filter((value): value is MiniMapInit => Boolean(value));
  }

  flush(): MiniMapDelta[] {
    const messages: MiniMapDelta[] = [];
    for (const state of this.areas.values()) {
      if (state.pending.size === 0) continue;
      state.revision += 1;
      messages.push({
        v: PROTOCOL_VERSION,
        mapRevision: state.geometry.mapRevision,
        areaId: state.geometry.areaId,
        revision: state.revision,
        ranges: encodeCellRanges(state.pending),
      });
      state.pending.clear();
    }
    return messages;
  }

  takeGeometryUpdates(): MiniMapInit[] {
    if (!this.geometryDirty) return [];
    this.geometryDirty = false;
    return this.allInit();
  }

  private addArea(areaId: string, rects: readonly WorldRect[], bounds: WorldRect, mapRevision: string): void {
    const walls = boundarySegments(rects);
    const grid = createMiniMapGrid(bounds);
    const surfaces = rects.map((rect, index) => rectToMiniMapSurface(rect, `${areaId}:surface:${index}`));
    const geometry: MiniMapGeometry = {
      mapRevision,
      areaId,
      bounds,
      ...grid,
      surfaces,
      wallSegments: walls,
      visionRadius: PLAYER_VISION_RADIUS,
      markers: [],
    };
    this.areas.set(areaId, {
      geometry,
      wallIndex: createWallSpatialIndex(walls),
      mask: createExplorationMask(geometry),
      pending: new Set(),
      revision: 0,
    });
  }

  private refreshMarkers(): void {
    const markers = new Map<string, MiniMapGeometry["markers"]>();
    for (const areaId of this.areas.keys()) markers.set(areaId, []);
    for (const waypoint of this.core.waypoints.values()) {
      if (!waypoint.active && waypoint.kind !== "gate" && waypoint.kind !== "boss") continue;
      const areaId = this.core.options.world ? OFFICIAL_AREA_ID : `zone-${waypoint.zone}`;
      const areaMarkers = markers.get(areaId);
      if (!areaMarkers) continue;
      const kind = waypoint.kind === "boss" ? "boss" : waypoint.kind === "gate" ? "gate" : "waypoint";
      areaMarkers.push({
        id: waypoint.id,
        kind,
        label: kind === "boss" ? "마왕의 제단" : kind === "gate" ? "구역 게이트" : "활성 웨이포인트",
        x: waypoint.x,
        y: waypoint.y,
        areaId,
      });
    }
    const signature = JSON.stringify([...markers.entries()]);
    if (signature === this.markerSignature) return;
    this.markerSignature = signature;
    for (const [areaId, next] of markers) this.areas.get(areaId)!.geometry.markers = next;
    this.geometryDirty = true;
  }
}
