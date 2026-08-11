export {
  computeVisibilityPolygon,
  computeVisibilityRays,
  createWallSpatialIndex,
  visibilityPolygonFromRays,
  type VisibilityRay,
  type VisionWallSegment,
  type WallSpatialIndex,
} from "@five-days/game-core";

const MAX_VISION_REVEAL_SOURCES = 8;

export type VisionRevealSource = {
  id: string;
  x: number;
  y: number;
  radius: number;
};

export function selectVisionRevealSources(
  player: VisionRevealSource,
  installedSources: Iterable<VisionRevealSource>,
  maximum = MAX_VISION_REVEAL_SOURCES,
): VisionRevealSource[] {
  if (maximum <= 0) return [];
  const unique = new Map<string, VisionRevealSource>();
  for (const source of installedSources) {
    if (source.id === player.id || source.radius <= 0) continue;
    unique.set(source.id, source);
  }
  return [player, ...[...unique.values()].sort((left, right) => left.id.localeCompare(right.id))]
    .slice(0, maximum);
}
