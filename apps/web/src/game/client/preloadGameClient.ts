import { HERO_SPRITE_PATHS } from "./render/heroSprites";
import { BASIC_ATTACK_SPRITE_PATHS } from "./render/attackEffectSprites";

const GAMEPLAY_IMAGE_ASSETS = [
  ...Object.values(HERO_SPRITE_PATHS),
  "/Asset/zone-1-vegetation.png",
  "/Asset/zone-1-room-corridor-atlas.png",
  "/Asset/zone-1-blocked-forest.png",
  "/Asset/zone-2-vegetation.png",
  "/Asset/zone-2-room-corridor-atlas.png",
  "/Asset/zone-2-blocked-marsh.png",
  "/Asset/zone-3-vegetation.png",
  "/Asset/zone-3-room-corridor-atlas.png",
  "/Asset/zone-3-blocked-wastes.png",
  "/Asset/waypoints/waypoint-circle-zone-1.png",
  "/Asset/waypoints/waypoint-circle-zone-2.png",
  "/Asset/waypoints/waypoint-circle-zone-3.png",
  "/Asset/sprites/skeleton-unarmed-8dir-walk-v1.png",
  ...BASIC_ATTACK_SPRITE_PATHS,
  "/Asset/ui/augment-cards/augment-card-normal.webp",
  "/Asset/ui/augment-cards/augment-card-rare.webp",
  "/Asset/ui/augment-cards/augment-card-epic.webp",
] as const;

export async function preloadGameClient(): Promise<void> {
  if (typeof window === "undefined") return;
  await Promise.all([
    ...GAMEPLAY_IMAGE_ASSETS.map(loadImage),
    import("../runtime/createGame"),
  ]);
}

function loadImage(source: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (typeof image.decode !== "function") {
        resolve();
        return;
      }
      void image.decode().then(resolve, () => reject(new Error(`게임 이미지를 해독하지 못했습니다: ${source}`)));
    };
    image.onerror = () => reject(new Error(`게임 이미지를 불러오지 못했습니다: ${source}`));
    image.src = source;
  });
}
