import {
  BOSS_ROOM_ID,
  MINIMAP_VISION_RADIUS,
  boundsOf,
  buildWorldFromRooms,
  createExplorationMask,
  createMiniMapGrid,
  encodeCellRanges,
  encodeMask,
  rectToMiniMapSurface,
  revealAround,
  type GameCore,
} from "@five-days/game-core";
import { PROTOCOL_VERSION, type MiniMapDelta, type MiniMapGeometry, type MiniMapInit } from "@five-days/protocol";

type AreaState = {
  geometry: MiniMapGeometry;
  mask: Uint8Array;
  pending: Set<number>;
  revision: number;
};

export class PartyExploration {
  private readonly areas = new Map<string, AreaState>();
  private markerSignature = "";
  private geometryDirty = false;

  constructor(private readonly core: GameCore) {
    for (const zone of core.maps.zones) {
      const rooms = [...core.rooms.values()].filter((room) => room.zone === zone.zone && room.id !== BOSS_ROOM_ID);
      const world = buildWorldFromRooms(rooms, zone.zone === 3);
      const bounds = boundsOf(world.rects);
      const areaId = `zone-${zone.zone}`;
      const grid = createMiniMapGrid(bounds);
      const surfaces = world.rects.map((rect, index) => rectToMiniMapSurface(rect, `${areaId}:surface:${index}`));
      const geometry: MiniMapGeometry = {
        mapRevision: `${core.options.seed}:${areaId}`,
        areaId,
        bounds,
        ...grid,
        surfaces,
        markers: [],
      };
      this.areas.set(areaId, { geometry, mask: createExplorationMask(geometry), pending: new Set(), revision: 0 });
    }
    this.refreshMarkers();
  }

  areaIdForRoom(roomId: string): string | null {
    const room = this.core.rooms.get(roomId as never);
    return room ? `zone-${room.zone}` : roomId === BOSS_ROOM_ID ? "zone-3" : null;
  }

  update(): void {
    this.refreshMarkers();
    for (const player of this.core.players.values()) {
      if (!player.connected || !player.alive) continue;
      const area = this.areaIdForRoom(player.roomId);
      const state = area ? this.areas.get(area) : undefined;
      if (!state) continue;
      for (const index of revealAround(state.geometry, state.mask, player.x, player.y, MINIMAP_VISION_RADIUS)) {
        state.pending.add(index);
      }
    }
  }

  init(areaId: string): MiniMapInit | null {
    const state = this.areas.get(areaId);
    if (!state) return null;
    return {
      v: PROTOCOL_VERSION,
      geometry: state.geometry,
      revision: state.revision,
      explorationMask: encodeMask(state.mask),
    };
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

  private refreshMarkers(): void {
    for (const state of this.areas.values()) state.geometry.markers = [];
    for (const waypoint of this.core.waypoints.values()) {
      if (!waypoint.active && waypoint.kind !== "gate" && waypoint.kind !== "boss") continue;
      const areaId = `zone-${waypoint.zone}`;
      const state = this.areas.get(areaId);
      if (!state) continue;
      const kind = waypoint.kind === "boss" ? "boss" : waypoint.kind === "gate" ? "gate" : "waypoint";
      state.geometry.markers.push({
        id: waypoint.id,
        kind,
        label: kind === "boss" ? "마왕의 제단" : kind === "gate" ? "구역 게이트" : "활성 웨이포인트",
        x: waypoint.x,
        y: waypoint.y,
        areaId,
      });
    }
    const signature = JSON.stringify([...this.areas.values()].map((state) => state.geometry.markers));
    if (signature !== this.markerSignature) {
      this.markerSignature = signature;
      this.geometryDirty = true;
    }
  }
}
