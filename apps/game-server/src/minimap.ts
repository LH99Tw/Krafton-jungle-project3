import {
  BOSS_ROOM_ID,
  OFFICIAL_MAP_MANIFEST,
  boundarySegments,
  boundsOf,
  buildWorldFromRooms,
  createExplorationMask,
  createMiniMapGrid,
  encodeCellRanges,
  encodeMask,
  rectToMiniMapSurface,
  revealRoomRect,
  type GameCore,
  type WorldRect,
} from "@five-days/game-core";
import { PLAYER_VISION_RADIUS, PROTOCOL_VERSION, type MiniMapDelta, type MiniMapGeometry, type MiniMapInit } from "@five-days/protocol";

type AreaState = {
  geometry: MiniMapGeometry;
  mask: Uint8Array;
  revision: number;
  pending: Set<number>;
};

const OFFICIAL_AREA_ID = "official-map";
export class PartyExploration {
  private readonly areas = new Map<string, AreaState>();
  private markerSignature = "";
  private geometryDirty = false;
  private readonly revealedRooms = new Set<string>();

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
    this.revealDiscoveredRooms();
    this.refreshMarkers();
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
    const deltas: MiniMapDelta[] = [];
    for (const state of this.areas.values()) {
      if (state.pending.size === 0) continue;
      state.revision += 1;
      deltas.push({
        v: PROTOCOL_VERSION,
        mapRevision: state.geometry.mapRevision,
        areaId: state.geometry.areaId,
        revision: state.revision,
        ranges: encodeCellRanges(state.pending),
      });
      state.pending.clear();
    }
    return deltas;
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
      mask: createExplorationMask(geometry),
      revision: 0,
      pending: new Set<number>(),
    });
  }

  private revealDiscoveredRooms(): void {
    for (const roomId of this.core.discoveredRooms) {
      const areaId = this.areaIdForRoom(roomId);
      const state = areaId ? this.areas.get(areaId) : null;
      const key = areaId ? `${areaId}:${roomId}` : roomId;
      if (!state || this.revealedRooms.has(key)) continue;
      this.revealedRooms.add(key);
      for (const index of revealRoomRect(state.geometry, state.mask, this.core.roomRectOf(roomId))) state.pending.add(index);
    }
  }

  private refreshMarkers(): void {
    const markers = new Map<string, MiniMapGeometry["markers"]>();
    for (const areaId of this.areas.keys()) markers.set(areaId, []);
    for (const room of this.core.rooms.values()) {
      const kind = room.kind === "resource" ? "resource"
        : room.kind === "static-monster" ? "monster"
          : room.kind === "hidden-monster" ? "elite"
            : null;
      if (!kind) continue;
      const areaId = this.areaIdForRoom(room.id);
      const areaMarkers = areaId ? markers.get(areaId) : null;
      if (!areaId || !areaMarkers) continue;
      const center = this.core.roomWorldCenterOf(room.id);
      areaMarkers.push({
        id: `room-marker:${room.id}`,
        roomId: room.id,
        kind,
        label: kind === "resource" ? "자원 방" : kind === "elite" ? "정예 몬스터 방" : "몬스터 방",
        x: center.x,
        y: center.y,
        areaId,
        active: true,
      });
    }
    for (const waypoint of this.core.waypoints.values()) {
      const areaId = this.core.options.world ? OFFICIAL_AREA_ID : `zone-${waypoint.zone}`;
      const areaMarkers = markers.get(areaId);
      if (!areaMarkers) continue;
      const kind = waypoint.kind === "boss" ? "boss" : waypoint.kind === "gate" ? "gate" : "waypoint";
      areaMarkers.push({
        id: waypoint.id,
        roomId: waypoint.roomId,
        kind,
        label: kind === "boss" ? "마왕의 제단" : kind === "gate" ? "구역 게이트" : "활성 웨이포인트",
        x: waypoint.x,
        y: waypoint.y,
        areaId,
        active: waypoint.active,
      });
    }
    const signature = JSON.stringify([...markers.entries()]);
    if (signature === this.markerSignature) return;
    this.markerSignature = signature;
    for (const [areaId, next] of markers) this.areas.get(areaId)!.geometry.markers = next;
    this.geometryDirty = true;
  }
}
