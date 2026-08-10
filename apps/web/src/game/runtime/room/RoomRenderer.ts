import * as Phaser from "phaser";
import { CLASS_DEFINITIONS } from "../../content/classes";
import type { HeroClassId } from "../../domain/types";
import { createGameTextures } from "../../client/render/createTextures";
import {
  BASE_CORE,
  BUILD_BOUNDS,
  ROOM_VIEW,
  type DoorLayout,
  type RenderableRoom,
  type RenderWorldRoom,
  type RenderZoneWorld,
} from "./layout";

const ZONE_COLORS = {
  1: { floor: 0x20372d, tile: 0x2d4a39, wall: 0x456653, accent: 0x9ed6a9 },
  2: { floor: 0x193432, tile: 0x254844, wall: 0x37655e, accent: 0x76c9bc },
  3: { floor: 0x2d2035, tile: 0x412b4c, wall: 0x65406d, accent: 0xc58ad2 },
} as const;

const ROOM_NAMES: Record<RenderableRoom["type"], string> = {
  start: "원정대 야영지",
  gate: "균열 관문",
  resource: "고대 채집지",
  "static-monster": "봉인된 사냥터",
  empty: "고요한 방",
  "central-waypoint": "중앙 웨이포인트",
  "hidden-monster": "숨겨진 시련",
  boss: "마왕의 제단",
};

export class RoomRenderer {
  private roomObjects: Phaser.GameObjects.GameObject[] = [];
  private crosshair!: Phaser.GameObjects.Image;

  constructor(private readonly scene: Phaser.Scene) {}

  create(): void {
    createGameTextures(this.scene);
    this.createCrosshairTexture();
    this.crosshair = this.scene.add.image(640, 360, "medieval-crosshair").setDepth(200).setScrollFactor(0);
    this.scene.game.canvas.style.cursor = "none";
  }

  renderRoom(
    room: RenderableRoom,
    doors: readonly DoorLayout[],
    options: { showBuildGrid: boolean; waypointActive: boolean },
  ): void {
    this.clearRoom();
    const palette = ZONE_COLORS[room.zone as keyof typeof ZONE_COLORS] ?? ZONE_COLORS[3];
    const graphics = this.track(this.scene.add.graphics().setDepth(-20));
    graphics.fillStyle(room.type === "boss" ? 0x160f1d : palette.floor).fillRect(0, 0, ROOM_VIEW.width, ROOM_VIEW.height);
    graphics.fillStyle(room.type === "hidden-monster" ? 0x201428 : palette.tile, 0.72)
      .fillRect(ROOM_VIEW.left, ROOM_VIEW.top, ROOM_VIEW.right - ROOM_VIEW.left, ROOM_VIEW.bottom - ROOM_VIEW.top);
    graphics.lineStyle(1, palette.accent, 0.08);
    for (let x = ROOM_VIEW.left; x <= ROOM_VIEW.right; x += 40) graphics.lineBetween(x, ROOM_VIEW.top, x, ROOM_VIEW.bottom);
    for (let y = ROOM_VIEW.top; y <= ROOM_VIEW.bottom; y += 40) graphics.lineBetween(ROOM_VIEW.left, y, ROOM_VIEW.right, y);

    graphics.fillStyle(palette.wall, 0.98)
      .fillRect(0, 0, ROOM_VIEW.width, ROOM_VIEW.top)
      .fillRect(0, ROOM_VIEW.bottom, ROOM_VIEW.width, ROOM_VIEW.height - ROOM_VIEW.bottom)
      .fillRect(0, ROOM_VIEW.top, ROOM_VIEW.left, ROOM_VIEW.bottom - ROOM_VIEW.top)
      .fillRect(ROOM_VIEW.right, ROOM_VIEW.top, ROOM_VIEW.width - ROOM_VIEW.right, ROOM_VIEW.bottom - ROOM_VIEW.top);
    graphics.lineStyle(3, palette.accent, 0.5).strokeRect(
      ROOM_VIEW.left,
      ROOM_VIEW.top,
      ROOM_VIEW.right - ROOM_VIEW.left,
      ROOM_VIEW.bottom - ROOM_VIEW.top,
    );

    for (const door of doors) this.drawDoor(graphics, door, palette.accent);
    this.drawRoomLandmark(graphics, room, palette.accent, options.waypointActive);
    if (options.showBuildGrid) this.drawBuildGrid(graphics);

    const title = this.track(this.scene.add.text(ROOM_VIEW.width / 2, 20, ROOM_NAMES[room.type], {
      fontFamily: "Georgia, serif",
      fontSize: "18px",
      color: "#eef6ec",
      stroke: "#111817",
      strokeThickness: 4,
    }).setOrigin(0.5).setDepth(3));
    title.setData("roomId", room.id);
    this.track(this.scene.add.text(ROOM_VIEW.width / 2, 41, `ZONE ${room.zone} · ${room.x},${room.y}`, {
      fontFamily: "monospace",
      fontSize: "9px",
      color: Phaser.Display.Color.IntegerToColor(palette.accent).rgba,
      letterSpacing: 2,
    }).setOrigin(0.5).setDepth(3));
  }

  /**
   * Draws a whole zone as one continuous world: rooms fill world rectangles and
   * connected rooms are joined by paved walkway corridors (통로). Non-walkable
   * gaps render as walls, so the world reads as a seamless, connected map.
   */
  renderWorld(world: RenderZoneWorld, options: { showBuildGrid: boolean; waypointRooms: ReadonlySet<string> }): void {
    this.clearRoom();
    const palette = ZONE_COLORS[world.rooms[0]?.room.zone as keyof typeof ZONE_COLORS] ?? ZONE_COLORS[1];
    const graphics = this.track(this.scene.add.graphics().setDepth(-20));

    // Outer void + wall backdrop covering the whole world bounds.
    graphics.fillStyle(0x0a0d0b, 1).fillRect(
      world.bounds.x - 60,
      world.bounds.y - 60,
      world.bounds.width + 120,
      world.bounds.height + 120,
    );
    graphics.fillStyle(palette.wall, 0.9).fillRect(world.bounds.x, world.bounds.y, world.bounds.width, world.bounds.height);

    // Paved corridors connecting rooms.
    for (const corridor of world.corridors) this.drawWalkway(graphics, corridor, palette.accent);

    // Rooms.
    for (const entry of world.rooms) {
      this.drawWorldRoom(graphics, entry, palette, options);
    }
  }

  private drawWalkway(graphics: Phaser.GameObjects.Graphics, corridor: { x: number; y: number; width: number; height: number }, accent: number): void {
    const horizontal = corridor.width > corridor.height;
    const thickness = Math.min(corridor.width, corridor.height);
    const base = Math.max(24, thickness / 2 - 6);
    const edge = horizontal ? base : base;
    graphics.fillStyle(0x2a2f38, 0.95).fillRect(corridor.x - 2, corridor.y - 2, corridor.width + 4, corridor.height + 4);
    graphics.fillStyle(0x6f7988, 0.98).fillRect(corridor.x + 2, corridor.y + 2, corridor.width - 4, corridor.height - 4);
    graphics.lineStyle(1, 0x9aa5b6, 0.35);
    const step = 46;
    if (horizontal) {
      for (let x = corridor.x; x < corridor.x + corridor.width; x += step) {
        for (let y = corridor.y + (edge - 34); y < corridor.y + corridor.height - (edge - 34); y += step) {
          graphics.strokeRect(x + 2, y + 2, 36, 36);
        }
      }
    } else {
      for (let y = corridor.y; y < corridor.y + corridor.height; y += step) {
        for (let x = corridor.x + (edge - 34); x < corridor.x + corridor.width - (edge - 34); x += step) {
          graphics.strokeRect(x + 2, y + 2, 36, 36);
        }
      }
    }
    // Accent trim along the corridor edges.
    graphics.lineStyle(3, accent, 0.55);
    if (horizontal) {
      graphics.lineBetween(corridor.x, corridor.y, corridor.x + corridor.width, corridor.y);
      graphics.lineBetween(corridor.x, corridor.y + corridor.height, corridor.x + corridor.width, corridor.y + corridor.height);
    } else {
      graphics.lineBetween(corridor.x, corridor.y, corridor.x, corridor.y + corridor.height);
      graphics.lineBetween(corridor.x + corridor.width, corridor.y, corridor.x + corridor.width, corridor.y + corridor.height);
    }
  }

  private drawWorldRoom(
    graphics: Phaser.GameObjects.Graphics,
    entry: RenderWorldRoom,
    palette: { floor: number; tile: number; wall: number; accent: number },
    options: { showBuildGrid: boolean; waypointRooms: ReadonlySet<string> },
  ): void {
    const { room, rect, center } = entry;
    const floor = room.type === "boss" ? 0x160f1d : palette.floor;
    graphics.fillStyle(floor, 0.98).fillRect(rect.x, rect.y, rect.width, rect.height);
    graphics.fillStyle(room.type === "hidden-monster" ? 0x201428 : palette.tile, 0.7)
      .fillRect(rect.x + 16, rect.y + 16, rect.width - 32, rect.height - 32);
    graphics.lineStyle(1, palette.accent, 0.1);
    for (let x = rect.x; x <= rect.x + rect.width; x += 40) graphics.lineBetween(x, rect.y, x, rect.y + rect.height);
    for (let y = rect.y; y <= rect.y + rect.height; y += 40) graphics.lineBetween(rect.x, y, rect.x + rect.width, y);
    graphics.lineStyle(3, palette.accent, 0.6).strokeRect(rect.x, rect.y, rect.width, rect.height);

    this.drawWorldLandmark(graphics, entry, palette.accent, options.waypointRooms.has(room.id));

    const title = this.track(this.scene.add.text(center.x, rect.y + 22, ROOM_NAMES[room.type] ?? room.type, {
      fontFamily: "Georgia, serif",
      fontSize: "17px",
      color: "#eef6ec",
      stroke: "#111817",
      strokeThickness: 4,
    }).setOrigin(0.5).setDepth(3));
    title.setData("roomId", room.id);
    this.track(this.scene.add.text(center.x, rect.y + 42, `ZONE ${room.zone} · ${room.x},${room.y}`, {
      fontFamily: "monospace",
      fontSize: "9px",
      color: Phaser.Display.Color.IntegerToColor(palette.accent).rgba,
      letterSpacing: 2,
    }).setOrigin(0.5).setDepth(3));

    if (room.type === "start" && room.zone === 1) {
      this.track(this.scene.add.image(center.x, center.y + 40, "core").setDepth(2));
    } else if (options.showBuildGrid && room.zone === 1 && room.type === "start") {
      this.drawBuildGridWorld(graphics, rect);
    }
  }

  private drawWorldLandmark(
    graphics: Phaser.GameObjects.Graphics,
    entry: RenderWorldRoom,
    accent: number,
    waypointActive: boolean,
  ): void {
    const { room, rect, center } = entry;
    if (room.type === "resource") {
      graphics.fillStyle(0xe0c271, 0.22).fillCircle(center.x - 120, center.y - 60, 34).fillCircle(center.x + 40, center.y + 70, 28).fillCircle(center.x + 150, center.y - 90, 22);
      graphics.lineStyle(2, 0xffe6a4, 0.55).strokeCircle(center.x - 120, center.y - 60, 34).strokeCircle(center.x + 40, center.y + 70, 28).strokeCircle(center.x + 150, center.y - 90, 22);
    } else if (room.type === "hidden-monster") {
      graphics.lineStyle(3, 0xc77de0, 0.34).strokeCircle(center.x, center.y, 235).strokeCircle(center.x, center.y, 205);
    } else if (room.type === "boss") {
      graphics.lineStyle(4, 0xff6aa7, 0.46).strokeCircle(center.x, center.y, 270).strokeCircle(center.x, center.y, 235);
    } else if (room.type === "central-waypoint") {
      graphics.fillStyle(accent, 0.15).fillCircle(center.x, center.y, 38);
      graphics.lineStyle(3, accent, 0.72).strokeCircle(center.x, center.y, 38);
    }
    if (waypointActive) {
      const label = room.type === "gate"
        ? room.zone === 3 ? "마왕전 진입 웨이포인트" : "다음 구역 웨이포인트"
        : room.type === "central-waypoint" ? "중앙 귀환 웨이포인트" : "귀환 웨이포인트";
      this.track(this.scene.add.circle(center.x, center.y, 42, 0x8de5c1, 0.15).setStrokeStyle(3, 0xb8f5dc, 0.92).setDepth(2));
      this.track(this.scene.add.text(center.x, center.y + 58, label, {
        fontFamily: "sans-serif",
        fontSize: "11px",
        color: "#bdf5de",
        backgroundColor: "#13211dcc",
        padding: { x: 7, y: 4 },
      }).setOrigin(0.5).setDepth(3));
    }
  }

  private drawBuildGridWorld(graphics: Phaser.GameObjects.Graphics, rect: { x: number; y: number; width: number; height: number }): void {
    const bounds = BUILD_BOUNDS;
    graphics.fillStyle(0x77d8b2, 0.04).fillRect(
      rect.x + bounds.minX,
      rect.y + bounds.minY,
      bounds.maxX - bounds.minX,
      bounds.maxY - bounds.minY,
    );
    graphics.lineStyle(1, 0x9adcc1, 0.22);
    for (let x = rect.x + bounds.minX; x <= rect.x + bounds.maxX; x += BUILD_BOUNDS.gridSize) {
      graphics.lineBetween(x, rect.y + bounds.minY, x, rect.y + bounds.maxY);
    }
    for (let y = rect.y + bounds.minY; y <= rect.y + bounds.maxY; y += BUILD_BOUNDS.gridSize) {
      graphics.lineBetween(rect.x + bounds.minX, y, rect.x + bounds.maxX, y);
    }
    graphics.lineStyle(2, 0xb1eed6, 0.54).strokeRect(
      rect.x + bounds.minX,
      rect.y + bounds.minY,
      bounds.maxX - bounds.minX,
      bounds.maxY - bounds.minY,
    );
  }

  updateCrosshair(pointer: Phaser.Input.Pointer): void {
    this.crosshair?.setPosition(pointer.x, pointer.y);
  }

  createHero(classId: HeroClassId, x: number, y: number, alpha = 1): Phaser.Physics.Arcade.Sprite {
    const hero = this.scene.physics.add.sprite(x, y, `hero-${classId}`);
    hero.setDepth(20).setAlpha(alpha);
    (hero.body as Phaser.Physics.Arcade.Body).setCircle(11, 3, 7);
    return hero;
  }

  createEnemy(kind: "static" | "hidden" | "gate" | "invader" | "boss", x: number, y: number): Phaser.Physics.Arcade.Sprite {
    const texture = kind === "hidden" ? "enemy-elite" : kind === "gate" ? "gate" : kind === "boss" ? "boss" : kind === "invader" ? "enemy-runner" : "enemy-grunt";
    const enemy = this.scene.physics.add.sprite(x, y, texture).setDepth(kind === "boss" ? 18 : 12);
    const radius = kind === "boss" ? 48 : kind === "gate" ? 26 : kind === "hidden" ? 18 : 11;
    (enemy.body as Phaser.Physics.Arcade.Body).setCircle(radius);
    if (kind === "gate" || kind === "boss") enemy.setImmovable(true);
    return enemy;
  }

  createDrop(x: number, y: number, rarity: "legendary" | "mythic"): Phaser.GameObjects.Container {
    const color = rarity === "mythic" ? 0xff7ac8 : 0xffd66e;
    const rune = this.scene.add.star(0, 0, rarity === "mythic" ? 8 : 6, 7, 16, color, 0.82)
      .setStrokeStyle(2, 0xffffff, 0.78);
    const label = this.scene.add.text(0, 25, rarity === "mythic" ? "신화 장비" : "레전더리 장비", {
      fontFamily: "sans-serif",
      fontSize: "9px",
      color: rarity === "mythic" ? "#ffb5e2" : "#ffe8a4",
      backgroundColor: "#111718cc",
      padding: { x: 4, y: 2 },
    }).setOrigin(0.5);
    return this.scene.add.container(x, y, [rune, label]).setDepth(24);
  }

  showWaypoint(label: string): void {
    const circle = this.track(this.scene.add.circle(ROOM_VIEW.width / 2, ROOM_VIEW.height / 2, 42, 0x8de5c1, 0.15)
      .setStrokeStyle(3, 0xb8f5dc, 0.92).setDepth(2));
    this.scene.tweens.add({ targets: circle, alpha: 0.36, scale: 1.08, yoyo: true, repeat: -1, duration: 800 });
    this.track(this.scene.add.text(ROOM_VIEW.width / 2, ROOM_VIEW.height / 2 + 58, label, {
      fontFamily: "sans-serif",
      fontSize: "11px",
      color: "#bdf5de",
      backgroundColor: "#13211dcc",
      padding: { x: 7, y: 4 },
    }).setOrigin(0.5).setDepth(3));
  }

  showAttack(x1: number, y1: number, x2: number, y2: number, color: number): void {
    const trace = this.scene.add.graphics().lineStyle(3, color, 0.9).lineBetween(x1, y1, x2, y2).setDepth(30);
    this.scene.tweens.add({ targets: trace, alpha: 0, duration: 110, onComplete: () => trace.destroy() });
  }

  showImpact(x: number, y: number, radius: number, color: number): void {
    const impact = this.scene.add.circle(x, y, 7, color, 0.28).setStrokeStyle(2, color, 0.9).setDepth(32);
    this.scene.tweens.add({ targets: impact, radius, alpha: 0, duration: 230, onComplete: () => impact.destroy() });
  }

  destroy(): void {
    this.clearRoom();
    this.crosshair?.destroy();
    this.scene.game.canvas.style.cursor = "";
  }

  private drawDoor(graphics: Phaser.GameObjects.Graphics, door: DoorLayout, accent: number): void {
    graphics.fillStyle(0x0a1011, 1);
    graphics.lineStyle(3, accent, 0.8);
    if (door.direction === "north" || door.direction === "south") {
      graphics.fillRect(door.x - ROOM_VIEW.doorHalfSize, door.y - 18, ROOM_VIEW.doorHalfSize * 2, 36);
      graphics.strokeRect(door.x - ROOM_VIEW.doorHalfSize, door.y - 18, ROOM_VIEW.doorHalfSize * 2, 36);
    } else {
      graphics.fillRect(door.x - 18, door.y - ROOM_VIEW.doorHalfSize, 36, ROOM_VIEW.doorHalfSize * 2);
      graphics.strokeRect(door.x - 18, door.y - ROOM_VIEW.doorHalfSize, 36, ROOM_VIEW.doorHalfSize * 2);
    }
  }

  private drawRoomLandmark(
    graphics: Phaser.GameObjects.Graphics,
    room: RenderableRoom,
    accent: number,
    waypointActive: boolean,
  ): void {
    if (room.type === "start" && room.zone === 1) {
      this.track(this.scene.add.image(BASE_CORE.x, BASE_CORE.y, "core").setDepth(2));
      graphics.fillStyle(0x77d8b2, 0.08).fillCircle(BASE_CORE.x, BASE_CORE.y, 92);
    } else if (room.type === "resource") {
      graphics.fillStyle(0xe0c271, 0.22).fillCircle(520, 300, 34).fillCircle(680, 430, 28).fillCircle(790, 270, 22);
      graphics.lineStyle(2, 0xffe6a4, 0.55).strokeCircle(520, 300, 34).strokeCircle(680, 430, 28).strokeCircle(790, 270, 22);
    } else if (room.type === "hidden-monster") {
      graphics.lineStyle(3, 0xc77de0, 0.34).strokeCircle(640, 360, 235).strokeCircle(640, 360, 205);
    } else if (room.type === "boss") {
      graphics.lineStyle(4, 0xff6aa7, 0.46).strokeCircle(640, 350, 270).strokeCircle(640, 350, 235);
    } else if (room.type === "central-waypoint") {
      graphics.fillStyle(accent, 0.15).fillCircle(640, 360, 38);
      graphics.lineStyle(3, accent, 0.72).strokeCircle(640, 360, 38);
    }
    if (waypointActive) {
      const label = room.type === "gate"
        ? room.zone === 3 ? "마왕전 진입 웨이포인트" : "다음 구역 웨이포인트"
        : room.type === "central-waypoint" ? "중앙 귀환 웨이포인트" : "귀환 웨이포인트";
      this.showWaypoint(label);
    }
  }

  private drawBuildGrid(graphics: Phaser.GameObjects.Graphics): void {
    graphics.fillStyle(0x77d8b2, 0.04).fillRect(
      BUILD_BOUNDS.minX,
      BUILD_BOUNDS.minY,
      BUILD_BOUNDS.maxX - BUILD_BOUNDS.minX,
      BUILD_BOUNDS.maxY - BUILD_BOUNDS.minY,
    );
    graphics.lineStyle(1, 0x9adcc1, 0.22);
    for (let x = BUILD_BOUNDS.minX; x <= BUILD_BOUNDS.maxX; x += BUILD_BOUNDS.gridSize) {
      graphics.lineBetween(x, BUILD_BOUNDS.minY, x, BUILD_BOUNDS.maxY);
    }
    for (let y = BUILD_BOUNDS.minY; y <= BUILD_BOUNDS.maxY; y += BUILD_BOUNDS.gridSize) {
      graphics.lineBetween(BUILD_BOUNDS.minX, y, BUILD_BOUNDS.maxX, y);
    }
    graphics.lineStyle(2, 0xb1eed6, 0.54).strokeRect(
      BUILD_BOUNDS.minX,
      BUILD_BOUNDS.minY,
      BUILD_BOUNDS.maxX - BUILD_BOUNDS.minX,
      BUILD_BOUNDS.maxY - BUILD_BOUNDS.minY,
    );
  }

  private createCrosshairTexture(): void {
    if (this.scene.textures.exists("medieval-crosshair")) return;
    const graphics = this.scene.make.graphics({ x: 0, y: 0 }, false);
    graphics.lineStyle(2, 0xffe8a1, 0.98).strokeCircle(18, 18, 8);
    graphics.lineStyle(2, 0x3b2618, 0.9)
      .lineBetween(18, 0, 18, 8)
      .lineBetween(18, 28, 18, 36)
      .lineBetween(0, 18, 8, 18)
      .lineBetween(28, 18, 36, 18);
    graphics.fillStyle(0xffd56d, 1)
      .fillTriangle(18, 1, 14, 7, 22, 7)
      .fillTriangle(18, 35, 14, 29, 22, 29)
      .fillTriangle(1, 18, 7, 14, 7, 22)
      .fillTriangle(35, 18, 29, 14, 29, 22)
      .fillCircle(18, 18, 2);
    graphics.generateTexture("medieval-crosshair", 36, 36);
    graphics.destroy();
  }

  private track<T extends Phaser.GameObjects.GameObject>(object: T): T {
    this.roomObjects.push(object);
    return object;
  }

  private clearRoom(): void {
    for (const object of this.roomObjects) object.destroy();
    this.roomObjects = [];
  }
}

export function classColor(classId: HeroClassId): number {
  return CLASS_DEFINITIONS[classId].color;
}
