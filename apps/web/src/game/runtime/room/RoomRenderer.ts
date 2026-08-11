import * as Phaser from "phaser";
import { enemyFanPatternAngles, enemyFloorPatternCircles, enemyPatternConfig, type EnemyPatternTier } from "@five-days/game-core";
import { CLASS_DEFINITIONS } from "../../content/classes";
import type { HeroClassId } from "../../domain/types";
import { createGameTextures } from "../../client/render/createTextures";
import { HERO_SPRITE_SCALE, heroFrameForPose } from "../../client/render/heroSprites";
import {
  BUILD_BOUNDS,
  ROOM_VIEW,
  wallEnvelopeRects,
  type RenderableRoom,
  type RenderWorldRoom,
  type RenderZoneWorld,
} from "./layout";
import { selectRoomDecorTemplate } from "./roomDecorTemplates";

const ZONE_COLORS = {
  1: { floor: 0x20372d, tile: 0x2d4a39, wall: 0x456653, accent: 0x9ed6a9 },
  2: { floor: 0x193432, tile: 0x254844, wall: 0x37655e, accent: 0x76c9bc },
  3: { floor: 0x2d2035, tile: 0x412b4c, wall: 0x65406d, accent: 0xc58ad2 },
} as const;

type EnemyKind = "static" | "hidden" | "gate" | "invader" | "boss";

const ENEMY_LOOK = {
  static: { texture: "enemy-skeleton-0", depth: 12, radius: 11 },
  invader: { texture: "enemy-skeleton-0", depth: 12, radius: 11 },
  hidden: { texture: "enemy-elite", depth: 12, radius: 18 },
  gate: { texture: "gate", depth: 12, radius: 26 },
  boss: { texture: "boss", depth: 18, radius: 48 },
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
  private roomMasks: Phaser.Display.Masks.GeometryMask[] = [];
  private readonly enemyPatternObjects = new Map<string, { key: string; graphics: Phaser.GameObjects.Graphics }>();
  private crosshair!: Phaser.GameObjects.Image;

  constructor(private readonly scene: Phaser.Scene) {}

  create(): void {
    createGameTextures(this.scene);
    this.createVegetationFrames();
    this.createEnvironmentFrames();
    this.createCrosshairTexture();
    this.createSkeletonAnimations();
    this.crosshair = this.scene.add.image(640, 360, "medieval-crosshair").setDepth(200).setScrollFactor(0);
    this.scene.game.canvas.style.cursor = "none";
  }

  private createSkeletonAnimations(): void {
    if (!this.scene.textures.exists("skeleton-8dir-walk")) return;
    const SKELETON_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315] as const;
    SKELETON_ANGLES.forEach((angle, rowIndex) => {
      const animKey = `skeleton-walk-${angle}`;
      if (!this.scene.anims.exists(animKey)) {
        this.scene.anims.create({
          key: animKey,
          frames: this.scene.anims.generateFrameNumbers("skeleton-8dir-walk", {
            start: rowIndex * 8,
            end: rowIndex * 8 + 7,
          }),
          frameRate: 10,
          repeat: -1,
        });
      }
    });
  }

  /**
   * Draws a whole zone as one continuous world: rooms fill world rectangles and
   * connected rooms are joined by paved walkway corridors (통로). Non-walkable
   * gaps render as walls, so the world reads as a seamless, connected map.
   */
  renderWorld(world: RenderZoneWorld, options: { decorSeed: string; showBuildGrid: boolean; waypointRooms: ReadonlySet<string> }): void {
    this.clearRoom();
    const palette = ZONE_COLORS[world.rooms[0]?.room.zone as keyof typeof ZONE_COLORS] ?? ZONE_COLORS[1];
    const graphics = this.track(this.scene.add.graphics().setDepth(-18));
    const zone = world.rooms[0]?.room.zone ?? 1;

    // Pure black void. Only a half-tile envelope around rooms and corridors
    // receives terrain, making the rest read as intentionally nonexistent.
    const voidBackdrop = this.track(this.scene.add.graphics().setDepth(-40));
    voidBackdrop.fillStyle(0x000000, 1).fillRect(
      world.bounds.x - 60,
      world.bounds.y - 60,
      world.bounds.width + 120,
      world.bounds.height + 120,
    );
    const wallMaskShape = this.track(this.scene.make.graphics({}, false));
    wallMaskShape.fillStyle(0xffffff, 1);
    for (const rect of wallEnvelopeRects(world.walkable)) {
      wallMaskShape.fillRect(rect.x, rect.y, rect.width, rect.height);
    }
    const wallMask = wallMaskShape.createGeometryMask();
    this.roomMasks.push(wallMask);
    this.track(this.scene.add.tileSprite(
      world.bounds.x + world.bounds.width / 2,
      world.bounds.y + world.bounds.height / 2,
      world.bounds.width,
      world.bounds.height,
      `zone-${zone}-blocked`,
    ).setAlpha(0.86).setDepth(-30).setMask(wallMask));
    const wallTint = this.track(this.scene.add.graphics().setDepth(-29));
    wallTint.fillStyle(palette.wall, 0.22)
      .fillRect(world.bounds.x, world.bounds.y, world.bounds.width, world.bounds.height)
      .setMask(wallMask);

    // Paved corridors connecting rooms.
    for (const corridor of world.corridors) this.drawWalkway(graphics, corridor, zone, palette.accent);

    // Rooms.
    for (const entry of world.rooms) {
      this.drawWorldRoom(graphics, entry, palette, options, options.decorSeed);
    }

    if (world.wallSegments.length > 0) this.drawAutomaticWalls(graphics, world.wallSegments, palette.accent);

    // Procedural terrain decor (bushes/rocks) for map-template variety.
    this.drawWorldDecor(world, options.decorSeed);
  }

  /**
   * Deterministic vegetation placement layered over the selected room surface.
   * Props stay near room edges so combatants remain readable.
   */
  private drawWorldDecor(world: RenderZoneWorld, decorSeed: string): void {
    for (const entry of world.rooms) {
      const template = selectRoomDecorTemplate(decorSeed, entry.room);
      const texture = `zone-${entry.room.zone}-vegetation`;
      for (const placement of template.placements) {
        this.track(this.scene.add.image(
          entry.rect.x + entry.rect.width * placement.x,
          entry.rect.y + entry.rect.height * placement.y,
          texture,
          `prop-${placement.frame}`,
        ).setScale(placement.scale)
          .setAngle(placement.angle)
          .setFlipX(placement.flipX)
          .setAlpha(placement.alpha)
          .setDepth(1));
      }
    }
  }

  private createVegetationFrames(): void {
    for (const zone of [1, 2, 3] as const) {
      const key = `zone-${zone}-vegetation`;
      const texture = this.scene.textures.get(key);
      const source = texture.getSourceImage() as HTMLImageElement;
      for (let row = 0; row < 4; row += 1) {
        for (let column = 0; column < 4; column += 1) {
          const left = Math.floor(column * source.width / 4);
          const top = Math.floor(row * source.height / 4);
          const right = Math.floor((column + 1) * source.width / 4);
          const bottom = Math.floor((row + 1) * source.height / 4);
          texture.add(`prop-${row * 4 + column}`, 0, left, top, right - left, bottom - top);
        }
      }
    }
  }

  private createEnvironmentFrames(): void {
    for (const zone of [1, 2, 3] as const) {
      const texture = this.scene.textures.get(`zone-${zone}-room-corridor`);
      const source = texture.getSourceImage() as HTMLImageElement;
      for (let frame = 0; frame < 4; frame += 1) {
        const column = frame % 2;
        const row = Math.floor(frame / 2);
        const left = Math.floor(column * source.width / 2);
        const top = Math.floor(row * source.height / 2);
        const right = Math.floor((column + 1) * source.width / 2);
        const bottom = Math.floor((row + 1) * source.height / 2);
        texture.add(frame === 3 ? "corridor" : `room-${frame}`, 0, left, top, right - left, bottom - top);
      }
    }
  }

  private drawWalkway(graphics: Phaser.GameObjects.Graphics, corridor: { x: number; y: number; width: number; height: number }, zone: number, accent: number): void {
    const horizontal = corridor.width > corridor.height;
    const textureWidth = horizontal ? corridor.height : corridor.width;
    const textureHeight = horizontal ? corridor.width : corridor.height;
    this.track(this.scene.add.tileSprite(
      corridor.x + corridor.width / 2,
      corridor.y + corridor.height / 2,
      textureWidth,
      textureHeight,
      `zone-${zone}-room-corridor`,
      "corridor",
    ).setAngle(horizontal ? 90 : 0).setDepth(-22));
    graphics.fillStyle(0x121611, 0.18).fillRect(corridor.x, corridor.y, corridor.width, corridor.height);
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

  private drawAutomaticWalls(graphics: Phaser.GameObjects.Graphics, walls: RenderZoneWorld["wallSegments"], accent: number): void {
    graphics.lineStyle(24, 0x080b09, 0.98);
    for (const wall of walls) graphics.lineBetween(wall.x1, wall.y1, wall.x2, wall.y2);
    graphics.lineStyle(12, 0x29362d, 1);
    for (const wall of walls) graphics.lineBetween(wall.x1, wall.y1, wall.x2, wall.y2);
    graphics.lineStyle(2, accent, 0.55);
    for (const wall of walls) graphics.lineBetween(wall.x1, wall.y1, wall.x2, wall.y2);
  }

  private drawWorldRoom(
    graphics: Phaser.GameObjects.Graphics,
    entry: RenderWorldRoom,
    palette: { floor: number; tile: number; wall: number; accent: number },
    options: { showBuildGrid: boolean; waypointRooms: ReadonlySet<string> },
    decorSeed: string,
  ): void {
    const { room, rect, center } = entry;
    const roomVariant = stableIndex(`${decorSeed}:${room.id}:${room.type}`, 3);
    this.track(this.scene.add.tileSprite(
      center.x,
      center.y,
      rect.width,
      rect.height,
      `zone-${room.zone}-room-corridor`,
      `room-${roomVariant}`,
    ).setDepth(-22));
    const floor = room.type === "boss" ? 0x160f1d : palette.floor;
    graphics.fillStyle(floor, room.type === "boss" ? 0.58 : 0.2).fillRect(rect.x, rect.y, rect.width, rect.height);
    graphics.fillStyle(room.type === "hidden-monster" ? 0x201428 : palette.tile, 0.16)
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
      if (options.showBuildGrid) this.drawBuildGridWorld(graphics, rect);
    }
  }

  private drawWorldLandmark(
    graphics: Phaser.GameObjects.Graphics,
    entry: RenderWorldRoom,
    accent: number,
    waypointActive: boolean,
  ): void {
    const { room, center } = entry;
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
    hero.setDepth(20).setAlpha(alpha).setScale(HERO_SPRITE_SCALE);
    (hero.body as Phaser.Physics.Arcade.Body).setCircle(11, 3, 7);
    return hero;
  }

  updateHeroPose(hero: Phaser.Physics.Arcade.Sprite, aimAngle: number, moving: boolean, time: number): void {
    hero.setFrame(heroFrameForPose(aimAngle, moving, time)).setRotation(0);
    if (time < Number(hero.getData("attackPoseUntil") ?? 0)) return;
    hero.setScale(HERO_SPRITE_SCALE);
  }

  createEnemy(kind: EnemyKind, x: number, y: number): Phaser.Physics.Arcade.Sprite {
    const look = ENEMY_LOOK[kind];
    const isSkeleton = kind === "static" || kind === "invader" || kind === "hidden";
    const textureKey = isSkeleton ? "enemy-skeleton-0" : look.texture;

    const enemy = this.scene.physics.add.sprite(x, y, textureKey).setDepth(look.depth);
    (enemy.body as Phaser.Physics.Arcade.Body).setCircle(look.radius);
    if (kind === "gate" || kind === "boss") enemy.setImmovable(true);
    return enemy;
  }

  updateEnemyPose(sprite: Phaser.Physics.Arcade.Sprite, kind: string): void {
    if (!sprite.active || !sprite.body) return;
    const body = sprite.body as Phaser.Physics.Arcade.Body;
    const vx = body.velocity.x;
    const vy = body.velocity.y;
    const speedSq = vx * vx + vy * vy;

    if (speedSq > 4) {
      const angle = Phaser.Math.RadToDeg(Math.atan2(vy, vx));
      const normalized = (angle + 360) % 360;
      const snapAngle = (Math.round(normalized / 45) * 45) % 360;
      if (kind === "static" || kind === "invader" || kind === "hidden") {
        sprite.setTexture(`enemy-skeleton-${snapAngle}`);
      } else {
        sprite.setAngle(angle);
      }
    }
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

  showClassAttack(classId: HeroClassId, attacker: Phaser.Physics.Arcade.Sprite, x2: number, y2: number): void {
    const color = classColor(classId);
    const angle = Phaser.Math.Angle.Between(attacker.x, attacker.y, x2, y2);
    attacker.setData("attackPoseUntil", this.scene.time.now + 130);
    this.scene.tweens.add({ targets: attacker, scaleX: attacker.scaleX * 1.16, scaleY: attacker.scaleY * 0.9, duration: 55, yoyo: true });
    if (classId === "swordsman") {
      for (let trail = 0; trail < 3; trail += 1) {
        const slash = this.scene.add.arc(
          attacker.x,
          attacker.y,
          46 + trail * 11,
          Phaser.Math.RadToDeg(angle) - 58 + trail * 5,
          Phaser.Math.RadToDeg(angle) + 58 - trail * 5,
          false,
        ).setStrokeStyle(8 - trail * 2, trail === 0 ? 0xffffff : color, 0.92 - trail * 0.2).setDepth(31 - trail);
        this.scene.tweens.add({ targets: slash, scale: 1.35 + trail * 0.08, alpha: 0, duration: 150 + trail * 45, onComplete: () => slash.destroy() });
      }
    } else if (classId === "archer") {
      const arrow = this.scene.add.rectangle(attacker.x, attacker.y, 26, 5, color, 1).setRotation(angle).setDepth(31);
      this.scene.tweens.add({ targets: arrow, x: x2, y: y2, duration: 120, ease: "Quad.easeIn", onComplete: () => { this.showImpact(x2, y2, 25, color); arrow.destroy(); } });
      this.showAttack(attacker.x, attacker.y, x2, y2, color);
    } else {
      const orb = this.scene.add.circle(attacker.x, attacker.y, 12, color, 0.92).setStrokeStyle(4, 0xffffff, 0.9).setDepth(31);
      this.scene.tweens.add({ targets: orb, x: x2, y: y2, scale: 1.45, duration: 150, ease: "Sine.easeIn", onComplete: () => { this.showImpact(x2, y2, 48, color); orb.destroy(); } });
      const rune = this.scene.add.circle(attacker.x, attacker.y, 26, color, 0.06).setStrokeStyle(3, color, 0.8).setDepth(30);
      this.scene.tweens.add({ targets: rune, radius: 52, rotation: Math.PI, alpha: 0, duration: 260, onComplete: () => rune.destroy() });
    }
  }

  showImpact(x: number, y: number, radius: number, color: number): void {
    const impact = this.scene.add.circle(x, y, 7, color, 0.28).setStrokeStyle(2, color, 0.9).setDepth(32);
    this.scene.tweens.add({ targets: impact, radius, alpha: 0, duration: 230, onComplete: () => impact.destroy() });
  }

  updateEnemyPattern(
    enemyId: string,
    tier: EnemyPatternTier,
    patternKind: "fan" | "floor",
    patternPhase: "idle" | "telegraph",
    patternIndex: number,
    x: number,
    y: number,
    visible: boolean,
  ): void {
    const current = this.enemyPatternObjects.get(enemyId);
    if (!visible || patternPhase !== "telegraph") {
      current?.graphics.destroy();
      this.enemyPatternObjects.delete(enemyId);
      return;
    }
    const key = `${patternKind}:${patternIndex}`;
    if (current?.key === key) return;
    current?.graphics.destroy();
    const graphics = this.scene.add.graphics().setDepth(16);
    const config = enemyPatternConfig(tier);
    if (patternKind === "floor") {
      for (const circle of enemyFloorPatternCircles(x, y, patternIndex, tier)) {
        graphics.fillStyle(0xff315a, 0.16).fillCircle(circle.x, circle.y, circle.radius);
        graphics.lineStyle(4, 0xff6b82, 0.9).strokeCircle(circle.x, circle.y, circle.radius);
        graphics.lineStyle(1, 0xffffff, 0.5).strokeCircle(circle.x, circle.y, circle.radius * 0.72);
      }
    } else {
      for (const angle of enemyFanPatternAngles(patternIndex, tier)) {
        const endX = x + Math.cos(angle) * config.range;
        const endY = y + Math.sin(angle) * config.range;
        graphics.lineStyle(18, 0xff315a, 0.13).lineBetween(x, y, endX, endY);
        graphics.lineStyle(3, 0xff8ca0, 0.84).lineBetween(x, y, endX, endY);
      }
    }
    this.scene.tweens.add({ targets: graphics, alpha: 0.35, duration: 180, yoyo: true, repeat: -1 });
    this.enemyPatternObjects.set(enemyId, { key, graphics });
  }

  showEnemyMeleeAttack(enemy: Phaser.Physics.Arcade.Sprite, targetX: number, targetY: number): void {
    const angle = Phaser.Math.Angle.Between(enemy.x, enemy.y, targetX, targetY);
    const slash = this.scene.add.arc(enemy.x, enemy.y, 34, Phaser.Math.RadToDeg(angle) - 65, Phaser.Math.RadToDeg(angle) + 65, false)
      .setStrokeStyle(7, 0xff7a86, 0.9).setDepth(30);
    this.scene.tweens.add({ targets: enemy, scaleX: 1.22, scaleY: 0.82, duration: 90, yoyo: true });
    this.scene.tweens.add({ targets: slash, scale: 1.35, alpha: 0, duration: 210, onComplete: () => slash.destroy() });
    this.showImpact(targetX, targetY, 24, 0xff596c);
  }

  destroy(): void {
    this.clearRoom();
    this.crosshair?.destroy();
    this.scene.game.canvas.style.cursor = "";
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
    for (const pattern of this.enemyPatternObjects.values()) pattern.graphics.destroy();
    this.enemyPatternObjects.clear();
    for (const mask of this.roomMasks) mask.destroy();
    this.roomMasks = [];
    for (const object of this.roomObjects) object.destroy();
    this.roomObjects = [];
  }
}

export function classColor(classId: HeroClassId): number {
  return CLASS_DEFINITIONS[classId].color;
}

function stableIndex(value: string, count: number): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return Math.abs(hash) % count;
}
