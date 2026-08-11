import * as Phaser from "phaser";
import { PLAYER_VISION_RADIUS } from "@five-days/protocol";
import {
  computeVisibilityRays,
  createWallSpatialIndex,
  selectVisionRevealSources,
  visibilityPolygonFromRays,
  type VisionRevealSource,
  type VisibilityRay,
  type VisionWallSegment,
  type WallSpatialIndex,
} from "./vision";

const PLAYER_SOURCE_ID = "player";
const FOG_DEPTH = 180;
const FOG_WORLD_SIZE = 100_000;
const FOG_EDGE_INNER_SCALE = 0.94;
const FOG_EDGE_OUTER_SCALE = 1.06;

type FogLayer = {
  overlay: Phaser.GameObjects.Rectangle;
  aperture: Phaser.GameObjects.Graphics;
  mask: Phaser.Display.Masks.GeometryMask;
  radiusScale: number;
};

/**
 * A client-only, world-space fog layer. It never changes authoritative game
 * state: the player and future installed lights simply contribute reveal
 * apertures to the local HUD composition.
 */
export class PlayerVisionFog {
  private readonly installedSources = new Map<string, VisionRevealSource>();
  private readonly rayCache = new Map<string, { x: number; y: number; radius: number; revision: string; rays: VisibilityRay[] }>();
  private wallSegments: readonly VisionWallSegment[] = [];
  private wallIndex: WallSpatialIndex = createWallSpatialIndex([]);
  private wallRevision = "empty";
  private layers: FogLayer[] = [];
  private lastDrawSignature = "";

  constructor(private readonly scene: Phaser.Scene) {
    this.createLayers();
  }

  /** Register or update an installed light source such as a future lantern. */
  upsertRevealSource(source: VisionRevealSource): void {
    if (source.id === PLAYER_SOURCE_ID || source.radius <= 0) return;
    this.installedSources.set(source.id, { ...source });
  }

  removeRevealSource(id: string): void {
    this.installedSources.delete(id);
  }

  clearRevealSources(): void {
    this.installedSources.clear();
  }

  setWorld(wallSegments: readonly VisionWallSegment[], revision: string): void {
    if (revision === this.wallRevision) return;
    this.wallSegments = wallSegments;
    this.wallIndex = createWallSpatialIndex(wallSegments);
    this.wallRevision = revision;
    this.rayCache.clear();
    this.lastDrawSignature = "";
  }

  update(
    playerX: number,
    playerY: number,
  ): void {
    const sources = selectVisionRevealSources({
      id: PLAYER_SOURCE_ID,
      x: playerX,
      y: playerY,
      radius: PLAYER_VISION_RADIUS,
    }, this.installedSources.values());

    const signature = sources.map((source) => `${source.id}:${Math.round(source.x / 4)}:${Math.round(source.y / 4)}:${source.radius}`).join("|");
    if (signature === this.lastDrawSignature) return;
    this.lastDrawSignature = signature;

    for (const layer of this.layers) {
      layer.aperture.clear().fillStyle(0xffffff, 1);
      for (const source of sources) {
        const radius = source.radius * layer.radiusScale;
        const cached = this.cachedRays(source);
        const points = visibilityPolygonFromRays(source, cached, radius);
        if (points.length >= 3) layer.aperture.fillPoints(points, true);
      }
    }
  }

  destroy(): void {
    for (const layer of this.layers) {
      layer.overlay.clearMask(true);
      layer.mask.destroy();
      layer.aperture.destroy();
      layer.overlay.destroy();
    }
    this.layers = [];
    this.installedSources.clear();
    this.rayCache.clear();
  }

  private createLayers(): void {
    const layerCount = 3;
    this.layers = Array.from({ length: layerCount }, (_, index) => {
      const progress = index / (layerCount - 1);
      // Keep the playable area clear, then stack the fog layers across a
      // narrow band so visibility falls off rapidly just beyond the radius.
      const radiusScale = Phaser.Math.Linear(
        FOG_EDGE_INNER_SCALE,
        FOG_EDGE_OUTER_SCALE,
        progress,
      );
      const color = index % 3 === 0 ? 0x0a1712 : 0x030806;
      const alpha = Phaser.Math.Linear(0.65, 0.45, progress);
      const overlay = this.scene.add.rectangle(
        0,
        0,
        FOG_WORLD_SIZE,
        FOG_WORLD_SIZE,
        color,
        alpha,
      ).setDepth(FOG_DEPTH + index);
      const aperture = this.scene.make.graphics({}, false);
      const mask = aperture.createGeometryMask();
      mask.setInvertAlpha(true);
      overlay.setMask(mask);
      return {
        overlay,
        aperture,
        mask,
        radiusScale,
      };
    });
  }

  private cachedRays(source: VisionRevealSource): VisibilityRay[] {
    const cached = this.rayCache.get(source.id);
    if (cached && cached.revision === this.wallRevision && cached.radius === source.radius && Math.hypot(source.x - cached.x, source.y - cached.y) < 4) {
      return cached.rays;
    }
    const rays = computeVisibilityRays(source, source.radius * FOG_EDGE_OUTER_SCALE * 1.02, this.wallIndex);
    this.rayCache.set(source.id, { x: source.x, y: source.y, radius: source.radius, revision: this.wallRevision, rays });
    return rays;
  }
}
