import * as Phaser from "phaser";
import {
  selectVisionRevealSources,
  type VisionRevealSource,
} from "./vision";

const PLAYER_SOURCE_ID = "player";
const PLAYER_VISION_RADIUS = 400;
const FOG_DEPTH = 180;
const FOG_WORLD_SIZE = 100_000;

type FogLayer = {
  overlay: Phaser.GameObjects.Rectangle;
  aperture: Phaser.GameObjects.Graphics;
  mask: Phaser.Display.Masks.GeometryMask;
  radiusScale: number;
  phase: number;
};

/**
 * A client-only, screen-space fog layer. It never changes authoritative game
 * state: the player and future installed lights simply contribute reveal
 * apertures to the local HUD composition.
 */
export class PlayerVisionFog {
  private readonly installedSources = new Map<string, VisionRevealSource>();
  private layers: FogLayer[] = [];

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

  update(
    playerX: number,
    playerY: number,
    time: number,
  ): void {
    const sources = selectVisionRevealSources({
      id: PLAYER_SOURCE_ID,
      x: playerX,
      y: playerY,
      radius: PLAYER_VISION_RADIUS,
    }, this.installedSources.values());

    for (const layer of this.layers) {
      layer.aperture.clear().fillStyle(0xffffff, 1);
      for (let index = 0; index < sources.length; index += 1) {
        const source = sources[index];
        const drift = time * 0.00022 + layer.phase + index * 1.83;
        const breathing = 1 + Math.sin(drift * 0.73) * 0.018;
        const radius = source.radius * layer.radiusScale * breathing;
        const wander = source.radius * 0.018;
        const offsetX = Math.sin(drift) * wander;
        const offsetY = Math.cos(drift * 0.81) * wander;

        // Three overlapping apertures keep the boundary organic without a
        // costly full-screen shader. Their movement is slow enough to read as
        // drifting mist rather than a pulsing UI circle.
        layer.aperture
          .fillCircle(source.x + offsetX, source.y + offsetY, radius)
          .fillCircle(source.x - offsetX * 0.62, source.y + offsetY * 0.38, radius * 0.985)
          .fillCircle(source.x + offsetY * 0.44, source.y - offsetX * 0.52, radius * 0.972);
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
  }

  private createLayers(): void {
    const layerCount = 18;
    this.layers = Array.from({ length: layerCount }, (_, index) => {
      const progress = index / (layerCount - 1);
      const radiusScale = Phaser.Math.Linear(0.58, 1.18, progress);
      const color = index % 3 === 0 ? 0x0a1712 : 0x030806;
      const alpha = Phaser.Math.Linear(0.135, 0.075, progress);
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
        phase: index * 0.67,
      };
    });
  }
}
