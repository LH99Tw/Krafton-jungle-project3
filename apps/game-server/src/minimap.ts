import {
  BOSS_ROOM_ID,
  OFFICIAL_MAP_MANIFEST,
  boundarySegments,
  boundsOf,
  buildWorldFromRooms,
  createExplorationMask,
  createMiniMapGrid,
  encodeMask,
  rectToMiniMapSurface,
  type GameCore,
  type WorldRect,
} from "@five-days/game-core";
import { PLAYER_VISION_RADIUS, PROTOCOL_VERSION, type MiniMapDelta, type MiniMapGeometry, type MiniMapInit } from "@five-days/protocol";

type AreaState = {
  geometry: MiniMapGeometry;
  mask: Uint8Array;
  revision: number;
};

const OFFICIAL_AREA_ID = "official-map";
export class PartyExploration {
  private readonly areas = new Map<string, AreaState>();
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
    return [];
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
