import { createSeededRandom } from "@five-days/game-core";
import type { RenderableRoom } from "./layout";

export const ROOM_DECOR_TEMPLATE_COUNT = 16;

type RoomDecorPlacement = Readonly<{
  frame: number;
  x: number;
  y: number;
  scale: number;
  angle: number;
  flipX: boolean;
  alpha: number;
}>;

export type RoomDecorTemplate = Readonly<{
  id: number;
  placements: readonly RoomDecorPlacement[];
}>;

type DecorZone = 1 | 2 | 3;

export const ROOM_DECOR_TEMPLATES: Readonly<Record<DecorZone, readonly RoomDecorTemplate[]>> = {
  1: createZoneTemplates(1),
  2: createZoneTemplates(2),
  3: createZoneTemplates(3),
};

export function selectRoomDecorTemplate(runSeed: string, room: RenderableRoom): RoomDecorTemplate {
  const zone = normalizeZone(room.zone);
  const templates = ROOM_DECOR_TEMPLATES[zone];
  const random = createSeededRandom(`room-decor:${runSeed}:${room.id}:${room.type}`);
  return templates[random.integer(templates.length)] as RoomDecorTemplate;
}

function createZoneTemplates(zone: DecorZone): readonly RoomDecorTemplate[] {
  return Array.from({ length: ROOM_DECOR_TEMPLATE_COUNT }, (_, id): RoomDecorTemplate => {
    const random = createSeededRandom(`room-decor-template:${zone}:${id}`);
    const count = 6 + id % 5;
    const placements = Array.from({ length: count }, (): RoomDecorPlacement => {
      const side = random.integer(4);
      const along = 0.12 + random.next() * 0.76;
      const edge = 0.09 + random.next() * 0.1;
      const x = side === 2 ? edge : side === 3 ? 1 - edge : along;
      const y = side === 0 ? edge : side === 1 ? 1 - edge : along;
      return {
        frame: random.integer(16),
        x,
        y,
        scale: 0.16 + random.next() * 0.09,
        angle: (random.next() - 0.5) * 8,
        flipX: random.next() > 0.5,
        alpha: 0.72 + random.next() * 0.18,
      };
    });
    return { id, placements };
  });
}

function normalizeZone(zone: number): DecorZone {
  if (zone === 2 || zone === 3) return zone;
  return 1;
}
