import {
  createWallSpatialIndex,
  revealAround,
  type WallSpatialIndex,
} from "@five-days/game-core";
import type { MiniMapSnapshot } from "../domain/types";

export type ExplorationActor = Readonly<{
  id: string;
  roomId: string;
  x: number;
  y: number;
  connected?: boolean;
  alive?: boolean;
}>;

const MOVE_THRESHOLD = 4;

/**
 * Visual-only party trail calculation. The server still owns room discovery and
 * every gameplay decision; browsers own the minimap pixels they render.
 */
export class ClientPartyExploration {
  private readonly wallIndexes = new Map<string, WallSpatialIndex>();
  private readonly lastPositions = new Map<string, { mapRevision: string; x: number; y: number }>();

  reveal(minimap: MiniMapSnapshot, actors: readonly ExplorationActor[]): number {
    const { geometry } = minimap;
    let wallIndex = this.wallIndexes.get(geometry.mapRevision);
    if (!wallIndex) {
      wallIndex = createWallSpatialIndex(geometry.wallSegments);
      this.wallIndexes.set(geometry.mapRevision, wallIndex);
    }

    let revealed = 0;
    for (const actor of actors) {
      if (actor.connected === false || actor.alive === false) continue;
      const previous = this.lastPositions.get(actor.id);
      if (previous?.mapRevision === geometry.mapRevision
        && Math.hypot(actor.x - previous.x, actor.y - previous.y) < MOVE_THRESHOLD) continue;
      this.lastPositions.set(actor.id, { mapRevision: geometry.mapRevision, x: actor.x, y: actor.y });
      revealed += revealAround(
        geometry,
        minimap.explorationMask,
        actor.x,
        actor.y,
        geometry.visionRadius,
        wallIndex,
      ).length;
    }
    return revealed;
  }

  clear(): void {
    this.wallIndexes.clear();
    this.lastPositions.clear();
  }
}
