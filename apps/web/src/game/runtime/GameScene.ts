import * as Phaser from "phaser";
import { createGameTextures } from "../client/render/createTextures";
import { BUILDINGS, DIFFICULTY, ENEMY_ARCHETYPES, WORLD } from "../content/balance";
import { CLASS_DEFINITIONS, CLASS_ORDER } from "../content/classes";
import { draftUpgrades, UPGRADE_MAP } from "../content/upgrades";
import type {
  BuildMode,
  GameResult,
  GameSnapshot,
  GameStartOptions,
  HeroClassId,
  TeamStats,
  UpgradeId,
} from "../domain/types";
import { gameBridge, type GameCommand } from "./GameBridge";
import { ProgressionModel } from "../systems/ProgressionModel";
import { SessionDirector } from "../systems/SessionDirector";

type EnemyKind = "grunt" | "runner" | "elite" | "gate" | "boss";
type StructureKind = "turret" | "wall";

type EnemyData = {
  kind: EnemyKind;
  hp: number;
  maxHp: number;
  damage: number;
  speed: number;
  rewardXp: number;
  rewardGold: number;
  invader: boolean;
  gateId?: string;
  lastHitAt: number;
};

type StructureData = {
  kind: StructureKind;
  level: number;
  hp: number;
  maxHp: number;
  nextShotAt: number;
};

const PHASE_LABELS = {
  day: "낮 · 원정",
  night: "밤 · 총공세",
  standby: "정산 · 재정비",
  boss: "마왕전",
  ended: "원정 종료",
} as const;

export class GameScene extends Phaser.Scene {
  private readonly classDefinition;
  private readonly session: SessionDirector;
  private readonly difficulty;
  private progression: ProgressionModel;
  private player!: Phaser.Physics.Arcade.Sprite;
  private allies: Phaser.Physics.Arcade.Sprite[] = [];
  private enemies!: Phaser.Physics.Arcade.Group;
  private projectiles!: Phaser.Physics.Arcade.Group;
  private enemyProjectiles!: Phaser.Physics.Arcade.Group;
  private structures!: Phaser.Physics.Arcade.StaticGroup;
  private core!: Phaser.Physics.Arcade.Image;
  private cursors!: Record<"W" | "A" | "S" | "D", Phaser.Input.Keyboard.Key>;
  private qKey!: Phaser.Input.Keyboard.Key;
  private eKey!: Phaser.Input.Keyboard.Key;
  private dashKey!: Phaser.Input.Keyboard.Key;
  private returnKey!: Phaser.Input.Keyboard.Key;
  private commandDisconnect?: () => void;
  private buildMode: BuildMode = null;
  private gold = 100;
  private baseHp = WORLD.base.maxHp;
  private lastAutoAttackAt = 0;
  private qReadyAt = 0;
  private eReadyAt = 0;
  private dashReadyAt = 0;
  private invulnerableUntil = 0;
  private spawnAccumulator = 0;
  private snapshotAccumulator = 0;
  private bossPatternAt = 0;
  private bossGroundAt = 0;
  private bossSummonAt = 0;
  private boss?: Phaser.Physics.Arcade.Sprite;
  private gatesDestroyed = 0;
  private awaitingUpgrade = false;
  private ended = false;
  private playerDead = false;
  private retreatUsed = false;
  private currentMessage = "첫 게이트를 찾아 성장의 길을 여세요.";
  private gateSprites = new Map<string, Phaser.Physics.Arcade.Sprite>();
  private stats: TeamStats = {
    damage: 0,
    bossDamage: 0,
    kills: 0,
    deaths: 0,
    structuresBuilt: 0,
    goldSpent: 0,
    gatesDestroyed: 0,
  };

  constructor(private readonly options: GameStartOptions) {
    super({ key: "game" });
    this.classDefinition = CLASS_DEFINITIONS[options.heroClass];
    this.session = new SessionDirector(options.sessionMode);
    this.difficulty = DIFFICULTY[options.difficulty];
    this.progression = new ProgressionModel({
      ...this.classDefinition.stats,
      hp: this.classDefinition.stats.maxHp,
    });
  }

  create(): void {
    createGameTextures(this);
    this.physics.world.setBounds(0, 0, WORLD.width, WORLD.height);
    this.createWorld();
    this.createGroups();
    this.createCore();
    this.createPlayerParty();
    this.createGatesAndFieldEnemies();
    this.configurePhysics();
    this.configureInput();
    this.configureCamera();
    this.commandDisconnect = gameBridge.connect((command) => this.handleCommand(command));
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.cleanup());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.cleanup());
    gameBridge.emit("ready", undefined);
    this.emitSnapshot();
  }

  update(time: number, delta: number): void {
    if (this.ended) return;
    const safeDelta = Math.min(delta, 100);
    this.updateSession(safeDelta);
    this.updatePlayer(time);
    this.updateAllies(time);
    this.updateEnemies(time);
    this.updateProjectiles(time);
    this.updateStructures(time);
    this.updateSpawning(safeDelta);
    this.updateBoss(time);

    this.snapshotAccumulator += safeDelta;
    if (this.snapshotAccumulator >= 120) {
      this.snapshotAccumulator = 0;
      this.emitSnapshot();
    }
  }

  private createWorld(): void {
    const graphics = this.add.graphics();
    graphics.fillStyle(0x17231f).fillRect(0, 0, WORLD.width, WORLD.height);
    // Base Camp: Compact Stone Grey (#787D8A) cobblestone floor area
    this.drawStoneFloor(graphics, 600, 6000, 1600, 1200);

    // Zone 01 (Sunny Meadow): 3-Way Maze, Hedge/Tree Walls, and Blue Crystal Flower Shrines
    this.drawSunnyMeadowMaze(graphics);

    // Zone 02 (Corrupted Forest): Reddish Soil, Autumn Coral Trees, Torches & Blue Oasis Pond
    this.drawCorruptedForest(graphics);

    // Zone 03 (Outer Demon Castle): Magma Lakes, Carved Rune Walls & Demon Statues
    this.drawCastleOutskirts(graphics);

    graphics.fillStyle(0x17111e, 0.98).fillCircle(WORLD.arena.x, WORLD.arena.y, WORLD.arena.radius + 150);
    graphics.lineStyle(2, 0x3c594d, 0.42);
    for (let x = 0; x <= WORLD.width; x += 100) graphics.lineBetween(x, 0, x, WORLD.height);
    for (let y = 0; y <= WORLD.height; y += 100) graphics.lineBetween(0, y, WORLD.width, y);
    graphics.lineStyle(6, 0x7e4d93, 0.7).strokeCircle(WORLD.arena.x, WORLD.arena.y, WORLD.arena.radius);
    graphics.lineStyle(3, 0xb277c7, 0.24).strokeCircle(WORLD.arena.x, WORLD.arena.y, WORLD.arena.radius - 60);
    graphics.fillStyle(0x3b2a44, 0.7).fillCircle(4900, 5050, 300).fillCircle(8600, 3250, 400);
    graphics.fillStyle(0x456a57, 0.5).fillCircle(2350, 5650, 450).fillCircle(3900, 7150, 500);
    graphics.setDepth(-20);

    this.addZoneLabel(WORLD.base.x, WORLD.base.y + 250, "BASE CAMP", "베이스캠프", "#bdeed3");
    this.addZoneLabel(WORLD.gates[0].x, WORLD.gates[0].y + 150, "ZONE 01", "햇살 들판", "#d6e28d");
    this.addZoneLabel(WORLD.gates[1].x, WORLD.gates[1].y + 150, "ZONE 02", "오염된 숲", "#85c8ae");
    this.addZoneLabel(WORLD.gates[2].x, WORLD.gates[2].y + 150, "ZONE 03", "마왕성 외곽", "#c998db");
    this.addZoneLabel(WORLD.arena.x, WORLD.arena.y - WORLD.arena.radius - 50, "FINAL", "마왕의 제단", "#ff9ed1");

    const path = this.add.graphics().lineStyle(10, 0xd7cf9b, 0.22);
    path.beginPath();
    path.moveTo(WORLD.base.x + 200, WORLD.base.y - 30);
    path.lineTo(WORLD.gates[0].x, WORLD.gates[0].y);
    path.lineTo(WORLD.gates[1].x, WORLD.gates[1].y);
    path.lineTo(WORLD.gates[2].x, WORLD.gates[2].y);
    path.lineTo(WORLD.arena.x, WORLD.arena.y);
    path.strokePath();
    path.setDepth(-10);

    const buildGrid = this.add.graphics().lineStyle(1, 0x9adcc1, 0.18);
    const bounds = WORLD.buildBounds;
    for (let x = bounds.minX; x <= bounds.maxX; x += WORLD.gridSize) {
      buildGrid.lineBetween(x, bounds.minY, x, bounds.maxY);
    }
    for (let y = bounds.minY; y <= bounds.maxY; y += WORLD.gridSize) {
      buildGrid.lineBetween(bounds.minX, y, bounds.maxX, y);
    }
    buildGrid.lineStyle(3, 0x9adcc1, 0.35).strokeRect(
      bounds.minX,
      bounds.minY,
      bounds.maxX - bounds.minX,
      bounds.maxY - bounds.minY,
    );
  }

  private addZoneLabel(x: number, y: number, kicker: string, label: string, color: string): void {
    this.add
      .text(x, y, kicker, { fontFamily: "monospace", fontSize: "12px", color, letterSpacing: 3 })
      .setOrigin(0.5)
      .setAlpha(0.64)
      .setDepth(-5);
    this.add
      .text(x, y + 22, label, { fontFamily: "sans-serif", fontSize: "20px", color, fontStyle: "bold" })
      .setOrigin(0.5)
      .setAlpha(0.82)
      .setDepth(-5);
  }

  private drawStoneFloor(graphics: Phaser.GameObjects.Graphics, minX: number, minY: number, width: number, height: number): void {
    // Mortar Black base (#1E1E24)
    graphics.fillStyle(0x1e1e24, 0.98).fillRect(minX, minY, width, height);

    const tileSize = 20; // 1/4 of 80px for fine pixel stone floor
    const border = 2;
    for (let x = minX; x < minX + width; x += tileSize) {
      for (let y = minY; y < minY + height; y += tileSize) {
        const row = Math.floor((y - minY) / tileSize);
        const offsetX = (row % 2 === 0) ? 0 : tileSize / 2;
        const tileX = x + offsetX;
        const tileW = tileSize - border;
        const tileH = tileSize - border;

        const hash = (Math.floor(x / 20) * 17 + Math.floor(y / 20) * 31) % 10;
        let color = 0x787d8a; // Stone Grey (#787D8A)
        if (hash < 3) color = 0x4a4d55; // Deep Slate Grey (#4A4D55)
        else if (hash < 6) color = 0x787d8a; // Stone Grey (#787D8A)
        else if (hash < 8) color = 0xb0b7c6; // Dry Cobble Highlight (#B0B7C6)
        else color = 0x5c4a3c; // Earthy Clay Brown (#5C4A3C)

        // Draw fine stone brick
        graphics.fillStyle(color, 0.94).fillRect(tileX, y, tileW, tileH);

        // Highlight top & left border (#B0B7C6)
        graphics.fillStyle(0xb0b7c6, 0.35).fillRect(tileX, y, tileW, 1).fillRect(tileX, y, 1, tileH);

        // Shadow bottom & right border (#1E1E24)
        graphics.fillStyle(0x1e1e24, 0.55).fillRect(tileX, y + tileH - 1, tileW, 1).fillRect(tileX + tileW - 1, y, 1, tileH);

        // Moss / Lichen accents (#6A8F3D / #3E5C30)
        if (hash === 2 || hash === 7) {
          graphics.fillStyle(0x6a8f3d, 0.55).fillRect(tileX + 3, y + 3, 4, 3);
        } else if (hash === 5) {
          graphics.fillStyle(0x3e5c30, 0.65).fillRect(tileX + tileW - 5, y + tileH - 5, 4, 4);
        }
      }
    }
  }

  private drawSunnyMeadowMaze(graphics: Phaser.GameObjects.Graphics): void {
    const originX = 3000;
    const originY = 5200;
    const mazeW = 2000;
    const mazeH = 1600;

    // Meadow Grass Ground (#243b2c)
    graphics.fillStyle(0x243b2c, 0.95).fillRect(originX, originY, mazeW, mazeH);

    // 1. Paved Stone Walkways for 3-Way Maze Paths
    const drawWalkway = (x: number, y: number, w: number, h: number) => {
      graphics.fillStyle(0x353a44, 0.9).fillRect(x - 4, y - 4, w + 8, h + 8);
      graphics.fillStyle(0x7b8494, 0.96).fillRect(x, y, w, h);
      graphics.lineStyle(1, 0x9ca6b8, 0.35);
      for (let px = x; px < x + w; px += 40) {
        for (let py = y; py < y + h; py += 40) {
          graphics.strokeRect(px + 2, py + 2, 36, 36);
        }
      }
    };

    // Entrance path from Base Camp
    drawWalkway(3000, 5900, 400, 100);

    // 3-Way Junction Plaza (Crossroads) at (3400, 5600)
    drawWalkway(3400, 5600, 200, 700);

    // Branch 1 (Upper Branch)
    drawWalkway(3400, 5400, 800, 100);
    drawWalkway(4200, 5200, 100, 300);
    drawWalkway(4200, 5200, 700, 100);

    // Branch 2 (Center Main Branch)
    drawWalkway(3600, 5900, 1300, 100);

    // Branch 3 (Lower Branch)
    drawWalkway(3400, 6400, 800, 100);
    drawWalkway(4200, 6400, 100, 300);
    drawWalkway(4200, 6600, 700, 100);

    // 2. Hedge / Tree Maze Walls (#1d3822 dark green foliage & trees matching reference image)
    const drawHedgeWall = (x: number, y: number, w: number, h: number) => {
      graphics.fillStyle(0x162c1a, 0.98).fillRect(x, y, w, h);
      graphics.fillStyle(0x274a2e, 0.95).fillRect(x + 4, y + 4, w - 8, h - 8);
      for (let tx = x + 25; tx < x + w; tx += 50) {
        for (let ty = y + 25; ty < y + h; ty += 50) {
          graphics.fillStyle(0x1e3f26, 0.9).fillCircle(tx, ty, 24);
          graphics.fillStyle(0x32613d, 0.85).fillCircle(tx - 4, ty - 4, 18);
          graphics.fillStyle(0x498758, 0.7).fillCircle(tx - 6, ty - 6, 10);
        }
      }
    };

    // Hedge walls creating 3-way maze corridors
    drawHedgeWall(3000, 5200, 400, 650);
    drawHedgeWall(3000, 6050, 400, 750);

    drawHedgeWall(3600, 5200, 550, 150);
    drawHedgeWall(3600, 5550, 550, 300);
    drawHedgeWall(3600, 6050, 550, 300);
    drawHedgeWall(3600, 6550, 550, 250);

    drawHedgeWall(4350, 5350, 550, 500);
    drawHedgeWall(4350, 6050, 550, 500);

    // 3. Glowing Blue Crystal Flower Pedestals (Matching reference screenshot)
    const drawBlueFlowerPedestal = (px: number, py: number) => {
      graphics.fillStyle(0x525966).fillRect(px - 14, py - 14, 28, 28);
      graphics.fillStyle(0x8a94a6).fillRect(px - 11, py - 11, 22, 22);
      graphics.fillStyle(0xccd5e3).fillRect(px - 9, py - 9, 18, 4);

      this.add.circle(px, py, 26, 0x00e5ff, 0.22).setDepth(-8);
      this.add.circle(px, py, 14, 0x33f0ff, 0.38).setDepth(-7);

      graphics.fillStyle(0x00aaff).fillTriangle(px - 10, py, px + 10, py, px, py - 14);
      graphics.fillStyle(0x33d6ff).fillTriangle(px - 8, py - 4, px + 8, py - 4, px, py + 10);
      graphics.fillStyle(0xffffff).fillCircle(px, py - 2, 4);
    };

    // Shrines along the 3-way maze paths & junctions
    const flowerLocations = [
      { x: 3430, y: 5520 },
      { x: 3570, y: 5520 },
      { x: 3430, y: 6320 },
      { x: 3570, y: 6320 },
      { x: 4180, y: 5350 },
      { x: 4180, y: 6450 },
      { x: 3900, y: 5850 },
      { x: 3900, y: 6050 },
      { x: 4850, y: 5850 },
      { x: 4850, y: 6050 },
    ];

    flowerLocations.forEach((loc) => drawBlueFlowerPedestal(loc.x, loc.y));
  }

  private drawCorruptedForest(graphics: Phaser.GameObjects.Graphics): void {
    const originX = 5800;
    const originY = 2600;
    const forestW = 3800;
    const forestH = 3200;

    // 1. Reddish-Orange Corrupted Soil Base Ground (#3e2620 base, #8e3b22 / #cb5b37 patches - Matching Screenshot 1)
    graphics.fillStyle(0x3e2620, 0.96).fillRect(originX, originY, forestW, forestH);

    // Corrupted reddish-orange soil patches
    const drawSoilPatch = (x: number, y: number, w: number, h: number) => {
      graphics.fillStyle(0x8e3b22, 0.92).fillRect(x, y, w, h);
      graphics.fillStyle(0xcb5b37, 0.88).fillRect(x + 6, y + 6, w - 12, h - 12);
      graphics.fillStyle(0xe7643b, 0.6).fillCircle(x + w * 0.3, y + h * 0.4, w * 0.2);
      graphics.fillStyle(0xe7643b, 0.6).fillCircle(x + w * 0.7, y + h * 0.6, w * 0.15);
    };

    // Paved Golden-Orange Trail through the Corrupted Forest (#bd8448 / #dba15c - Matching Screenshot 2)
    const drawForestTrail = (x: number, y: number, w: number, h: number) => {
      graphics.fillStyle(0x523624, 0.9).fillRect(x - 4, y - 4, w + 8, h + 8);
      graphics.fillStyle(0xbd8448, 0.95).fillRect(x, y, w, h);
      graphics.fillStyle(0xdba15c, 0.7).fillRect(x + 4, y + 4, w - 8, h - 8);
    };

    drawSoilPatch(originX + 200, originY + 200, forestW - 400, forestH - 400);

    drawForestTrail(5800, 5900, 1400, 140);
    drawForestTrail(7000, 4100, 200, 1900); // Vertical trail to Forest Rift
    drawForestTrail(7000, 4100, 1800, 140); // Horizontal trail towards Zone 3

    // 2. Autumnal Coral/Red Trees & Dark Rock Walls (Matching Screenshot 2)
    const drawAutumnTree = (tx: number, ty: number, radius: number) => {
      graphics.fillStyle(0x3d2319).fillRect(tx - 6, ty, 12, radius * 0.8);
      graphics.fillStyle(0x7a2918, 0.95).fillCircle(tx, ty - 10, radius);
      graphics.fillStyle(0xad3f28, 0.92).fillCircle(tx - 4, ty - 14, radius * 0.8);
      graphics.fillStyle(0xd95a3d, 0.85).fillCircle(tx - 7, ty - 18, radius * 0.55);
      graphics.fillStyle(0xf0805d, 0.70).fillCircle(tx - 9, ty - 22, radius * 0.35);
    };

    const treeCoords = [
      { x: 6100, y: 5750, r: 45 }, { x: 6300, y: 5720, r: 55 }, { x: 6500, y: 5760, r: 48 },
      { x: 6700, y: 5730, r: 52 }, { x: 6900, y: 5750, r: 42 },
      { x: 6100, y: 6120, r: 50 }, { x: 6400, y: 6150, r: 58 }, { x: 6700, y: 6110, r: 46 },
      { x: 6850, y: 4400, r: 55 }, { x: 6850, y: 4700, r: 48 }, { x: 6850, y: 5000, r: 52 },
      { x: 7350, y: 4400, r: 50 }, { x: 7350, y: 4700, r: 56 }, { x: 7350, y: 5000, r: 44 },
      { x: 7350, y: 3950, r: 60 }, { x: 7650, y: 3950, r: 52 }, { x: 7950, y: 3950, r: 58 },
    ];
    treeCoords.forEach((t) => drawAutumnTree(t.x, t.y, t.r));

    // 3. Underground Blue Oasis Pond with Giant Lotus Flowers (Matching Screenshot 2!)
    const drawOasisPond = (cx: number, cy: number, pWidth: number, pHeight: number) => {
      graphics.fillStyle(0x543725).fillRect(cx - 10, cy - 10, pWidth + 20, pHeight + 20);
      graphics.fillStyle(0x73513a).fillRect(cx - 5, cy - 5, pWidth + 10, pHeight + 10);

      graphics.fillStyle(0x1a5276, 0.95).fillRect(cx, cy, pWidth, pHeight);
      graphics.fillStyle(0x2d82b7, 0.88).fillRect(cx + 8, cy + 8, pWidth - 16, pHeight - 16);
      graphics.fillStyle(0x4cb5f5, 0.65).fillRect(cx + 16, cy + 16, pWidth - 32, pHeight - 32);

      const drawLotus = (lx: number, ly: number) => {
        graphics.fillStyle(0x2e8548, 0.9).fillCircle(lx, ly, 22);
        graphics.fillStyle(0x48b868, 0.8).fillCircle(lx - 2, ly - 2, 16);
        graphics.fillStyle(0xd96f30).fillTriangle(lx - 10, ly + 4, lx + 10, ly + 4, lx, ly - 14);
        graphics.fillStyle(0xf09854).fillTriangle(lx - 7, ly - 2, lx + 7, ly - 2, lx, ly + 8);
        graphics.fillStyle(0xfff3ad).fillCircle(lx, ly - 2, 4);
      };

      drawLotus(cx + 40, cy + 50);
      drawLotus(cx + pWidth - 60, cy + 70);
      drawLotus(cx + 70, cy + pHeight - 50);
      drawLotus(cx + pWidth - 50, cy + pHeight - 60);
    };

    // Oasis Pond near the Forest Rift Gate at (7450, 4150)
    drawOasisPond(7450, 4150, 360, 240);

    // 4. Warm Fiery Torches with Orange Light Aura (Matching Screenshot 1 & 2!)
    const drawTorch = (tx: number, ty: number) => {
      graphics.fillStyle(0x3d281a).fillRect(tx - 3, ty - 6, 6, 24);
      graphics.fillStyle(0x8c7462).fillRect(tx - 5, ty - 8, 10, 4);

      this.add.circle(tx, ty - 12, 48, 0xff7700, 0.22).setDepth(-8);
      this.add.circle(tx, ty - 12, 26, 0xffaa00, 0.38).setDepth(-7);

      graphics.fillStyle(0xff5500).fillTriangle(tx - 6, ty - 6, tx + 6, ty - 6, tx, ty - 20);
      graphics.fillStyle(0xffaa00).fillTriangle(tx - 4, ty - 8, tx + 4, ty - 8, tx, ty - 18);
      graphics.fillStyle(0xffee77).fillCircle(tx, ty - 12, 3);
    };

    const torchLocations = [
      { x: 5950, y: 5830 }, { x: 6350, y: 5830 }, { x: 6750, y: 5830 },
      { x: 6930, y: 5500 }, { x: 6930, y: 5100 }, { x: 6930, y: 4700 },
      { x: 7150, y: 3980 }, { x: 7420, y: 3980 }, { x: 7850, y: 3980 },
      { x: 7420, y: 4420 }, { x: 7830, y: 4420 },
    ];
    torchLocations.forEach((t) => drawTorch(t.x, t.y));
  }

  private drawCastleOutskirts(graphics: Phaser.GameObjects.Graphics): void {
    const originX = 9000;
    const originY = 1000;
    const castleW = 3800;
    const castleH = 3200;

    // 1. Dark Volcanic Ash & Obsidian Base Ground (#16131c)
    graphics.fillStyle(0x16131c, 0.98).fillRect(originX, originY, castleW, castleH);

    // 2. Molten Magma Lakes & Lava Streams (#ff3300, #ff8800, #ffdd00 - Matching Screenshots 2 & 3!)
    const drawLavaPool = (lx: number, ly: number, lw: number, lh: number) => {
      graphics.fillStyle(0x421915, 0.95).fillRect(lx - 8, ly - 8, lw + 16, lh + 16);
      graphics.fillStyle(0xd62800, 0.98).fillRect(lx, ly, lw, lh);
      graphics.fillStyle(0xff6600, 0.92).fillRect(lx + 8, ly + 8, lw - 16, lh - 16);
      graphics.fillStyle(0xffcc00, 0.85).fillRect(lx + 16, ly + 16, lw - 32, lh - 32);

      this.add.circle(lx + lw / 2, ly + lh / 2, Math.max(lw, lh) * 0.7, 0xff5500, 0.2).setDepth(-8);
    };

    drawLavaPool(9200, 1400, 700, 350);
    drawLavaPool(10400, 1200, 800, 400);
    drawLavaPool(9500, 2900, 600, 600);
    drawLavaPool(10800, 2700, 900, 450);

    // 3. Dark Slate Fortress Tile Walkway (마왕성 통로)
    const drawCastlePavement = (x: number, y: number, w: number, h: number) => {
      graphics.fillStyle(0x1b2029, 0.98).fillRect(x - 4, y - 4, w + 8, h + 8);
      graphics.fillStyle(0x353e4f, 0.96).fillRect(x, y, w, h);
      graphics.lineStyle(2, 0x4f5c73, 0.45);
      for (let px = x; px < x + w; px += 40) {
        for (let py = y; py < y + h; py += 40) {
          graphics.strokeRect(px + 2, py + 2, 36, 36);
        }
      }
    };

    drawCastlePavement(8800, 4100, 1600, 140);
    drawCastlePavement(10150, 2400, 200, 1840);
    drawCastlePavement(10150, 2400, 1200, 140);

    // 4. Carved Ancient Rune Walls with Glowing Blue Orbs (Matching Screenshot 1!)
    const drawRuneWall = (wx: number, wy: number, ww: number, wh: number) => {
      graphics.fillStyle(0x151f1c, 0.98).fillRect(wx, wy, ww, wh);
      graphics.fillStyle(0x283834, 0.95).fillRect(wx + 4, wy + 4, ww - 8, wh - 8);
      graphics.lineStyle(2, 0x3d544f, 0.7).strokeRect(wx + 6, wy + 6, ww - 12, wh - 12);

      for (let ox = wx + 35; ox < wx + ww; ox += 70) {
        for (let oy = wy + 35; oy < wy + wh; oy += 70) {
          this.add.circle(ox, oy, 16, 0x00c8ff, 0.35).setDepth(-8);
          graphics.fillStyle(0x0f1715).fillCircle(ox, oy, 11);
          graphics.fillStyle(0x0099ff).fillCircle(ox, oy, 8);
          graphics.fillStyle(0x99e5ff).fillCircle(ox - 2, oy - 2, 3);
        }
      }
    };

    drawRuneWall(8800, 3850, 1350, 230);
    drawRuneWall(8800, 4260, 1350, 230);
    drawRuneWall(9900, 2250, 230, 1580);
    drawRuneWall(10370, 2250, 230, 1580);

    // 5. Demon Gargoyle Statues (Matching Screenshot 4!)
    const drawDemonStatue = (sx: number, sy: number) => {
      graphics.fillStyle(0x212730).fillRect(sx - 18, sy - 18, 36, 36);
      graphics.fillStyle(0x3e4754).fillRect(sx - 14, sy - 14, 28, 28);
      graphics.fillStyle(0x576375).fillTriangle(sx - 12, sy + 6, sx + 12, sy + 6, sx, sy - 16);
      graphics.fillStyle(0x7c8ba1).fillTriangle(sx - 14, sy - 4, sx - 4, sy - 4, sx - 9, sy - 18);
      graphics.fillStyle(0x7c8ba1).fillTriangle(sx + 4, sy - 4, sx + 14, sy - 4, sx + 9, sy - 18);
      graphics.fillStyle(0xff2200).fillCircle(sx - 4, sy - 6, 2);
      graphics.fillStyle(0xff2200).fillCircle(sx + 4, sy - 6, 2);
    };

    const statueLocations = [
      { x: 9950, y: 3950 }, { x: 10400, y: 3950 },
      { x: 9950, y: 3200 }, { x: 10400, y: 3200 },
      { x: 9950, y: 2500 }, { x: 10400, y: 2500 },
    ];
    statueLocations.forEach((st) => drawDemonStatue(st.x, st.y));

    // 6. Fiery Castle Torches along the Walls (Matching Screenshots 1 & 4!)
    const drawCastleTorch = (cx: number, cy: number) => {
      graphics.fillStyle(0x212730).fillRect(cx - 4, cy - 8, 8, 26);
      this.add.circle(cx, cy - 14, 50, 0xff6600, 0.25).setDepth(-8);
      this.add.circle(cx, cy - 14, 28, 0xffaa00, 0.40).setDepth(-7);
      graphics.fillStyle(0xff3300).fillTriangle(cx - 6, cy - 6, cx + 6, cy - 6, cx, cy - 22);
      graphics.fillStyle(0xffcc00).fillTriangle(cx - 4, cy - 8, cx + 4, cy - 8, cx, cy - 20);
      graphics.fillStyle(0xffffff).fillCircle(cx, cy - 14, 3);
    };

    const torchLocs = [
      { x: 9100, y: 3820 }, { x: 9500, y: 3820 },
      { x: 9100, y: 4280 }, { x: 9500, y: 4280 },
      { x: 10120, y: 3600 }, { x: 10120, y: 3000 },
      { x: 10420, y: 3600 }, { x: 10420, y: 3000 },
    ];
    torchLocs.forEach((t) => drawCastleTorch(t.x, t.y));
  }

  private createGroups(): void {
    this.enemies = this.physics.add.group();
    this.projectiles = this.physics.add.group({ maxSize: 260 });
    this.enemyProjectiles = this.physics.add.group({ maxSize: 220 });
    this.structures = this.physics.add.staticGroup();
  }

  private createCore(): void {
    this.core = this.physics.add.staticImage(WORLD.base.x, WORLD.base.y, "core");
    this.core.setDepth(2);
    this.add.circle(WORLD.base.x, WORLD.base.y, 112, 0x77d8b2, 0.08).setStrokeStyle(2, 0x9ce7cb, 0.34);
  }

  private createPlayerParty(): void {
    this.player = this.physics.add.sprite(WORLD.base.x + 120, WORLD.base.y, `hero-${this.options.heroClass}`);
    this.player.setDepth(10).setCollideWorldBounds(true);
    (this.player.body as Phaser.Physics.Arcade.Body).setCircle(11, 3, 7);

    const allyClassIds = CLASS_ORDER.filter((id) => id !== this.options.heroClass);
    this.allies = allyClassIds.map((classId, index) => {
      const ally = this.physics.add.sprite(
        WORLD.base.x + 90,
        WORLD.base.y + (index === 0 ? -55 : 55),
        `hero-${classId}`,
      );
      ally.setDepth(9).setAlpha(0.86).setData("classId", classId).setData("nextShotAt", 0);
      ally.body.setCircle(10, 4, 8);
      this.add
        .text(ally.x, ally.y - 26, index === 0 ? "동료 A" : "동료 B", {
          fontFamily: "sans-serif",
          fontSize: "10px",
          color: "#dce9e4",
          backgroundColor: "#18221fcc",
          padding: { x: 4, y: 2 },
        })
        .setOrigin(0.5)
        .setData("follow", ally)
        .setName("ally-label");
      return ally;
    });
  }

  private createGatesAndFieldEnemies(): void {
    WORLD.gates.forEach((gate) => {
      const sprite = this.spawnEnemy("gate", gate.x, gate.y, false, gate.zone, gate.id);
      sprite.setTexture("gate").setDisplaySize(62, 76).setImmovable(true);
      sprite.setData("name", gate.name);
      this.gateSprites.set(gate.id, sprite);
      this.add
        .text(gate.x, gate.y - 58, gate.name, {
          fontFamily: "sans-serif",
          fontSize: "13px",
          color: "#f2c7ff",
          backgroundColor: "#1b1220dd",
          padding: { x: 7, y: 4 },
        })
        .setOrigin(0.5)
        .setData("gateId", gate.id)
        .setName("gate-label");
    });

    const packs = [
      { x: 620, y: 1320, zone: 1, count: 7 },
      { x: 1040, y: 1030, zone: 1, count: 5 },
      { x: 1310, y: 900, zone: 2, count: 7 },
      { x: 1640, y: 720, zone: 2, count: 6 },
      { x: 1870, y: 590, zone: 3, count: 8 },
      { x: 2200, y: 520, zone: 3, count: 6 },
    ];

    packs.forEach((pack) => {
      for (let i = 0; i < pack.count; i += 1) {
        const angle = (Math.PI * 2 * i) / pack.count;
        const radius = 42 + (i % 3) * 24;
        const kind: EnemyKind = i % 5 === 0 ? "runner" : "grunt";
        this.spawnEnemy(kind, pack.x + Math.cos(angle) * radius, pack.y + Math.sin(angle) * radius, false, pack.zone);
      }
    });

    this.spawnEnemy("elite", 1110, 770, false, 1).setData("hidden", true);
    this.spawnEnemy("elite", 1770, 430, false, 2).setData("hidden", true);
    this.spawnEnemy("elite", 2360, 720, false, 3).setData("hidden", true);
  }

  private configurePhysics(): void {
    this.physics.add.overlap(this.projectiles, this.enemies, (projectile, enemy) => {
      this.onProjectileHit(projectile as Phaser.Physics.Arcade.Image, enemy as Phaser.Physics.Arcade.Sprite);
    });
    this.physics.add.overlap(this.enemyProjectiles, this.player, (projectile) => {
      this.disableProjectile(projectile as Phaser.Physics.Arcade.Image);
      this.damagePlayer(12);
    });
    this.physics.add.overlap(this.enemies, this.player, (enemy) => {
      const sprite = enemy as Phaser.Physics.Arcade.Sprite;
      const data = this.enemyData(sprite);
      if (data.kind === "gate" || data.kind === "boss") return;
      if (this.time.now - data.lastHitAt >= 850) {
        data.lastHitAt = this.time.now;
        this.damagePlayer(data.damage);
      }
    });
    this.physics.add.collider(this.enemies, this.structures, (enemy, structure) => {
      const enemySprite = enemy as Phaser.Physics.Arcade.Sprite;
      const structureSprite = structure as Phaser.Physics.Arcade.Image;
      const enemyData = this.enemyData(enemySprite);
      const structureData = structureSprite.getData("structure") as StructureData | undefined;
      if (!structureData || enemyData.kind === "gate" || enemyData.kind === "boss") return;
      if (this.time.now - enemyData.lastHitAt < 750) return;
      enemyData.lastHitAt = this.time.now;
      structureData.hp -= Math.max(1, enemyData.damage - structureData.level);
      structureSprite.setAlpha(Math.max(0.35, structureData.hp / structureData.maxHp));
      if (structureData.hp <= 0) structureSprite.destroy();
    });
  }

  private configureInput(): void {
    if (!this.input.keyboard) return;
    this.cursors = this.input.keyboard.addKeys("W,A,S,D") as Record<"W" | "A" | "S" | "D", Phaser.Input.Keyboard.Key>;
    this.qKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.Q);
    this.eKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.E);
    this.dashKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE, true);
    this.returnKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.B);
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (this.buildMode) this.tryBuildAt(pointer.worldX, pointer.worldY);
    });
  }

  private configureCamera(): void {
    this.cameras.main.setBounds(0, 0, WORLD.width, WORLD.height);
    this.cameras.main.startFollow(this.player, true, 0.09, 0.09);
    this.cameras.main.setZoom(1);
    this.cameras.main.setBackgroundColor(0x101517);
    this.cameras.main.fadeIn(450, 10, 20, 18);
  }

  private updateSession(deltaMs: number): void {
    const transition = this.session.update(deltaMs / 1000);
    if (!transition) return;
    if (transition.current === "night") {
      this.currentMessage = `${transition.day}일차 밤. 마왕군이 베이스로 몰려옵니다!`;
      this.flashCamera(0x4f1f58, 220);
    } else if (transition.current === "standby") {
      this.currentMessage = "정산 중. 시설을 보강하고 다음 원정을 준비하세요.";
      this.gold += 20 + transition.day * 5;
    } else if (transition.current === "day") {
      this.currentMessage = `${transition.day}일차 낮. 더 위험한 구역에서 힘을 모으세요.`;
      this.progression.stats.hp = Math.min(this.progression.stats.maxHp, this.progression.stats.hp + 14);
      this.flashCamera(0xd7cf9b, 180);
    } else if (transition.current === "ended") {
      this.finishGame("defeat", "5일의 시간이 끝났지만 마왕이 살아남았습니다.");
    }
  }

  private updatePlayer(time: number): void {
    if (this.playerDead || !this.player.active) return;
    let dx = 0;
    let dy = 0;
    if (this.cursors.A?.isDown) dx -= 1;
    if (this.cursors.D?.isDown) dx += 1;
    if (this.cursors.W?.isDown) dy -= 1;
    if (this.cursors.S?.isDown) dy += 1;
    const vector = new Phaser.Math.Vector2(dx, dy).normalize().scale(this.progression.stats.moveSpeed);
    this.player.setVelocity(vector.x, vector.y);

    if (this.session.phase === "boss") this.clampPlayerToArena();

    const pointer = this.input.activePointer;
    const aimAngle = Phaser.Math.Angle.Between(this.player.x, this.player.y, pointer.worldX, pointer.worldY);
    this.player.setFlipX(Math.cos(aimAngle) < 0);

    if (time >= this.lastAutoAttackAt) {
      const target = this.findTarget(this.player.x, this.player.y, this.progression.stats.attackRange, aimAngle);
      if (target) {
        this.performAutoAttack(target, aimAngle);
        this.lastAutoAttackAt = time + this.progression.stats.attackIntervalMs;
      }
    }

    if (Phaser.Input.Keyboard.JustDown(this.qKey) && time >= this.qReadyAt) this.useQSkill(aimAngle);
    if (Phaser.Input.Keyboard.JustDown(this.eKey) && time >= this.eReadyAt) this.useESkill(aimAngle);
    if (Phaser.Input.Keyboard.JustDown(this.dashKey) && time >= this.dashReadyAt) this.useDash(aimAngle);
    if (Phaser.Input.Keyboard.JustDown(this.returnKey)) this.returnToBase();
  }

  private updateAllies(time: number): void {
    this.allies.forEach((ally, index) => {
      if (!ally.active) return;
      const desiredAngle = this.time.now / 1800 + index * Math.PI;
      const targetX = this.player.x + Math.cos(desiredAngle) * 70;
      const targetY = this.player.y + Math.sin(desiredAngle) * 70;
      const distance = Phaser.Math.Distance.Between(ally.x, ally.y, targetX, targetY);
      if (distance > 28) this.physics.moveTo(ally, targetX, targetY, 175);
      else ally.setVelocity(0);

      const classId = ally.getData("classId") as HeroClassId;
      const classDef = CLASS_DEFINITIONS[classId];
      const target = this.findTarget(ally.x, ally.y, Math.min(380, classDef.stats.attackRange + 70));
      const nextShotAt = (ally.getData("nextShotAt") as number) ?? 0;
      if (target && time >= nextShotAt) {
        const angle = Phaser.Math.Angle.Between(ally.x, ally.y, target.x, target.y);
        this.spawnProjectile(
          ally.x,
          ally.y,
          angle,
          Math.max(3, Math.round(classDef.stats.attack * 0.7 + this.progression.level * 0.5)),
          classId === "mage" ? "magic-projectile" : "projectile",
          classId === "mage" ? 34 : 0,
        );
        ally.setData("nextShotAt", time + classDef.stats.attackIntervalMs * 1.45);
      }

      const label = this.children.list.find(
        (child) => child.name === "ally-label" && child.getData("follow") === ally,
      ) as Phaser.GameObjects.Text | undefined;
      label?.setPosition(ally.x, ally.y - 27);
    });
  }

  private updateEnemies(time: number): void {
    for (const child of this.enemies.getChildren()) {
      const enemy = child as Phaser.Physics.Arcade.Sprite;
      if (!enemy.active) continue;
      const data = this.enemyData(enemy);
      if (data.kind === "gate" || data.kind === "boss") {
        enemy.setVelocity(0);
        continue;
      }

      const targetsBase = data.invader && this.session.phase !== "boss";
      const targetX = targetsBase ? WORLD.base.x : this.player.x;
      const targetY = targetsBase ? WORLD.base.y : this.player.y;
      const distance = Phaser.Math.Distance.Between(enemy.x, enemy.y, targetX, targetY);
      if (!targetsBase && distance > 610 && this.session.phase !== "boss") {
        enemy.setVelocity(0);
        continue;
      }

      if (targetsBase && distance < 74) {
        enemy.setVelocity(0);
        if (time - data.lastHitAt >= 760) {
          data.lastHitAt = time;
          this.damageBase(data.damage);
        }
      } else {
        this.physics.moveTo(enemy, targetX, targetY, data.speed);
      }
    }
  }

  private updateProjectiles(time: number): void {
    [this.projectiles, this.enemyProjectiles].forEach((group) => {
      for (const child of group.getChildren()) {
        const projectile = child as Phaser.Physics.Arcade.Image;
        if (!projectile.active) continue;
        const expiresAt = projectile.getData("expiresAt") as number;
        if (time >= expiresAt || !this.physics.world.bounds.contains(projectile.x, projectile.y)) {
          this.disableProjectile(projectile);
        }
      }
    });
  }

  private updateStructures(time: number): void {
    for (const child of this.structures.getChildren()) {
      const structure = child as Phaser.Physics.Arcade.Image;
      const data = structure.getData("structure") as StructureData | undefined;
      if (!data || data.kind !== "turret" || time < data.nextShotAt) continue;
      const range = 290 + data.level * 35;
      const target = this.findTarget(structure.x, structure.y, range);
      if (!target) continue;
      const angle = Phaser.Math.Angle.Between(structure.x, structure.y, target.x, target.y);
      this.spawnProjectile(structure.x, structure.y, angle, 5 + data.level * 4, "projectile", data.level === 3 ? 28 : 0);
      data.nextShotAt = time + (820 - data.level * 120);
      structure.setRotation(angle + Math.PI / 2);
    }
  }

  private updateSpawning(deltaMs: number): void {
    if (this.session.phase === "standby" || this.session.phase === "boss" || this.session.phase === "ended") return;
    this.spawnAccumulator += deltaMs;
    const interval = this.session.phase === "night"
      ? Math.max(1050, 2600 - this.session.day * 220)
      : Math.max(6000, 10000 - this.session.day * 700);
    if (this.spawnAccumulator < interval) return;
    this.spawnAccumulator = 0;

    const activeGates = [...this.gateSprites.values()].filter((gate) => gate.active);
    activeGates.forEach((gate, index) => {
      const count = this.session.phase === "night" ? 1 + Math.floor(this.session.day / 3) : 1;
      for (let i = 0; i < count; i += 1) {
        const kind: EnemyKind = (this.session.day >= 2 && (index + i + this.stats.kills) % 4 === 0) ? "runner" : "grunt";
        this.spawnEnemy(kind, gate.x + Phaser.Math.Between(-30, 30), gate.y + Phaser.Math.Between(-30, 30), true, this.session.day);
      }
    });
  }

  private updateBoss(time: number): void {
    if (this.session.phase !== "boss" || !this.boss?.active) return;
    const bossData = this.enemyData(this.boss);
    const enraged = bossData.hp / bossData.maxHp <= 0.3;

    if (time >= this.bossPatternAt) {
      const count = enraged ? 16 : 12;
      const offset = Math.random() * Math.PI;
      for (let i = 0; i < count; i += 1) {
        const angle = offset + (Math.PI * 2 * i) / count;
        this.spawnEnemyProjectile(this.boss.x, this.boss.y, angle, enraged ? 235 : 190);
      }
      this.bossPatternAt = time + (enraged ? 2400 : 3400);
    }

    if (time >= this.bossGroundAt) {
      this.spawnGroundWarning(this.player.x, this.player.y, enraged ? 105 : 84, 22);
      this.allies.forEach((ally) => this.spawnGroundWarning(ally.x, ally.y, 64, 14));
      this.bossGroundAt = time + (enraged ? 4300 : 5800);
    }

    if (time >= this.bossSummonAt) {
      for (let i = 0; i < (enraged ? 5 : 3); i += 1) {
        const angle = (Math.PI * 2 * i) / (enraged ? 5 : 3);
        this.spawnEnemy(
          i % 2 === 0 ? "runner" : "grunt",
          this.boss.x + Math.cos(angle) * 150,
          this.boss.y + Math.sin(angle) * 150,
          false,
          3,
        );
      }
      this.currentMessage = "마왕이 소환문을 열었습니다. 탄막과 졸개를 함께 처리하세요!";
      this.bossSummonAt = time + 7200;
    }
  }

  private performAutoAttack(target: Phaser.Physics.Arcade.Sprite, aimAngle: number): void {
    const stats = this.progression.stats;
    if (this.classDefinition.attackKind === "melee" && !this.progression.has("swordsman-blade")) {
      const radius = stats.attackRange * (1 + (stats.projectileCount - 1) * 0.2);
      const slash = this.add.arc(this.player.x, this.player.y, radius, -48, 48, false, 0xffe79a, 0.18);
      slash.setRotation(aimAngle).setStrokeStyle(4, 0xfff0b8, 0.88).setDepth(12);
      this.tweens.add({ targets: slash, alpha: 0, scale: 1.15, duration: 150, onComplete: () => slash.destroy() });
      for (const child of this.enemies.getChildren()) {
        const enemy = child as Phaser.Physics.Arcade.Sprite;
        if (!enemy.active) continue;
        const distance = Phaser.Math.Distance.Between(this.player.x, this.player.y, enemy.x, enemy.y);
        if (distance > radius) continue;
        const angle = Phaser.Math.Angle.Between(this.player.x, this.player.y, enemy.x, enemy.y);
        if (Math.abs(Phaser.Math.Angle.Wrap(angle - aimAngle)) <= 0.95) this.damageEnemy(enemy, stats.attack);
      }
      return;
    }

    const count = Math.max(1, stats.projectileCount + (this.progression.has("archer-volley") ? 1 : 0));
    for (let i = 0; i < count; i += 1) {
      const spread = count === 1 ? 0 : (i - (count - 1) / 2) * 0.14;
      this.spawnProjectile(
        this.player.x,
        this.player.y,
        aimAngle + spread,
        stats.attack,
        this.classDefinition.attackKind === "magic" ? "magic-projectile" : "projectile",
        this.classDefinition.attackKind === "magic" ? (this.progression.has("mage-nova") ? 72 : 42) : 0,
      );
    }
  }

  private useQSkill(aimAngle: number): void {
    const skill = this.classDefinition.skills[0];
    const cooldownMultiplier = this.progression.has("mage-tempo") ? 0.75 : 1;
    this.qReadyAt = this.time.now + skill.cooldownMs * cooldownMultiplier;
    const damage = Math.round(this.progression.stats.attack * 2.1 * this.progression.stats.skillPower);

    if (this.options.heroClass === "swordsman") {
      this.damageInRadius(this.player.x + Math.cos(aimAngle) * 65, this.player.y + Math.sin(aimAngle) * 65, 145, damage);
      this.spawnImpact(this.player.x + Math.cos(aimAngle) * 70, this.player.y + Math.sin(aimAngle) * 70, 150, 0xf5d06f);
    } else if (this.options.heroClass === "archer") {
      this.spawnProjectile(this.player.x, this.player.y, aimAngle, damage, "projectile", 0, 5, 620);
    } else {
      const pointer = this.input.activePointer;
      const point = this.limitPointToRange(pointer.worldX, pointer.worldY, 420);
      this.spawnGroundWarning(point.x, point.y, this.progression.has("mage-nova") ? 155 : 112, damage, true);
    }
  }

  private useESkill(aimAngle: number): void {
    const skill = this.classDefinition.skills[1];
    const cooldownMultiplier = this.progression.has("mage-tempo") ? 0.75 : 1;
    this.eReadyAt = this.time.now + skill.cooldownMs * cooldownMultiplier;
    const damage = Math.round(this.progression.stats.attack * 1.65 * this.progression.stats.skillPower);

    if (this.options.heroClass === "swordsman") {
      this.invulnerableUntil = this.time.now + 340;
      this.player.x += Math.cos(aimAngle) * 180;
      this.player.y += Math.sin(aimAngle) * 180;
      this.damageInRadius(this.player.x, this.player.y, 100, Math.round(damage * 1.4));
      this.spawnImpact(this.player.x, this.player.y, 105, 0xffde83);
    } else if (this.options.heroClass === "archer") {
      const pointer = this.input.activePointer;
      const point = this.limitPointToRange(pointer.worldX, pointer.worldY, 440);
      const rain = this.add.circle(point.x, point.y, 122, 0x8fd99d, 0.12).setStrokeStyle(3, 0xcaffd5, 0.75);
      let ticks = 0;
      const event = this.time.addEvent({
        delay: 240,
        repeat: 5,
        callback: () => {
          ticks += 1;
          this.damageInRadius(point.x, point.y, 122, Math.max(2, Math.round(damage * 0.42)));
          this.spawnImpact(point.x + Phaser.Math.Between(-70, 70), point.y + Phaser.Math.Between(-70, 70), 24, 0xbaffc5);
          if (ticks >= 6) rain.destroy();
        },
      });
      rain.setData("event", event);
    } else {
      const startX = this.player.x;
      const startY = this.player.y;
      const point = this.limitPointToRange(
        this.player.x + Math.cos(aimAngle) * 205,
        this.player.y + Math.sin(aimAngle) * 205,
        205,
      );
      this.player.setPosition(point.x, point.y);
      this.invulnerableUntil = this.time.now + 280;
      this.damageInRadius(startX, startY, 95, damage);
      this.spawnImpact(startX, startY, 100, 0xc69bff);
    }
  }

  private useDash(aimAngle: number): void {
    this.dashReadyAt = this.time.now + 5000;
    this.invulnerableUntil = this.time.now + 260;
    const playerBody = this.player.body as Phaser.Physics.Arcade.Body;
    const direction = new Phaser.Math.Vector2(playerBody.velocity.x, playerBody.velocity.y);
    if (direction.lengthSq() < 1) direction.setToPolar(aimAngle, 1);
    direction.normalize();
    this.player.setPosition(this.player.x + direction.x * 150, this.player.y + direction.y * 150);
    this.player.setAlpha(0.35);
    this.time.delayedCall(230, () => this.player.active && this.player.setAlpha(1));
  }

  private spawnEnemy(
    kind: EnemyKind,
    x: number,
    y: number,
    invader: boolean,
    zone: number,
    gateId?: string,
  ): Phaser.Physics.Arcade.Sprite {
    const archetype = kind === "gate"
      ? { hp: WORLD.gates.find((gate) => gate.id === gateId)?.hp ?? 120, damage: 0, speed: 0, rewardXp: 30, rewardGold: 25 }
      : kind === "boss"
        ? ENEMY_ARCHETYPES.boss
        : ENEMY_ARCHETYPES[kind];
    const zoneMultiplier = kind === "boss" || kind === "gate" ? 1 : 1 + Math.max(0, zone - 1) * 0.22;
    const maxHp = Math.round(archetype.hp * zoneMultiplier * this.difficulty.enemyHp);
    const texture = kind === "gate" ? "gate" : kind === "boss" ? "boss" : `enemy-${kind}`;
    const enemy = this.enemies.create(x, y, texture) as Phaser.Physics.Arcade.Sprite;
    enemy.setDepth(kind === "boss" ? 8 : 6);
    (enemy.body as Phaser.Physics.Arcade.Body).setCircle(
      kind === "elite" ? 18 : kind === "boss" ? 48 : kind === "gate" ? 26 : 10,
    );
    const data: EnemyData = {
      kind,
      hp: maxHp,
      maxHp,
      damage: Math.round(archetype.damage * this.difficulty.enemyDamage + Math.max(0, zone - 1)),
      speed: archetype.speed * this.difficulty.enemySpeed,
      rewardXp: archetype.rewardXp,
      rewardGold: Math.round(archetype.rewardGold * this.difficulty.reward),
      invader,
      gateId,
      lastHitAt: 0,
    };
    enemy.setData("enemy", data);
    return enemy;
  }

  private findTarget(x: number, y: number, range: number, aimAngle?: number): Phaser.Physics.Arcade.Sprite | null {
    let best: Phaser.Physics.Arcade.Sprite | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const child of this.enemies.getChildren()) {
      const enemy = child as Phaser.Physics.Arcade.Sprite;
      if (!enemy.active) continue;
      const distance = Phaser.Math.Distance.Between(x, y, enemy.x, enemy.y);
      if (distance > range) continue;
      const angularPenalty = aimAngle === undefined
        ? 0
        : Math.abs(Phaser.Math.Angle.Wrap(Phaser.Math.Angle.Between(x, y, enemy.x, enemy.y) - aimAngle)) * 80;
      const score = distance + angularPenalty;
      if (score < bestScore) {
        best = enemy;
        bestScore = score;
      }
    }
    return best;
  }

  private spawnProjectile(
    x: number,
    y: number,
    angle: number,
    damage: number,
    texture: "projectile" | "magic-projectile",
    splashRadius = 0,
    pierce = 0,
    speed = 500,
  ): void {
    const projectile = this.projectiles.get(x, y, texture) as Phaser.Physics.Arcade.Image | null;
    if (!projectile) return;
    projectile.setTexture(texture).setActive(true).setVisible(true).setDepth(11).setRotation(angle);
    const projectileBody = projectile.body as Phaser.Physics.Arcade.Body;
    projectileBody.enable = true;
    projectile.setData({ damage, splashRadius, pierce, expiresAt: this.time.now + 1500, hitIds: new Set() });
    this.physics.velocityFromRotation(angle, speed, projectileBody.velocity);
  }

  private spawnEnemyProjectile(x: number, y: number, angle: number, speed: number): void {
    const projectile = this.enemyProjectiles.get(x, y, "enemy-projectile") as Phaser.Physics.Arcade.Image | null;
    if (!projectile) return;
    projectile.setTexture("enemy-projectile").setActive(true).setVisible(true).setDepth(10);
    const projectileBody = projectile.body as Phaser.Physics.Arcade.Body;
    projectileBody.enable = true;
    projectile.setData("expiresAt", this.time.now + 3400);
    this.physics.velocityFromRotation(angle, speed, projectileBody.velocity);
  }

  private onProjectileHit(projectile: Phaser.Physics.Arcade.Image, enemy: Phaser.Physics.Arcade.Sprite): void {
    if (!projectile.active || !enemy.active) return;
    const hitIds = projectile.getData("hitIds") as Set<Phaser.Physics.Arcade.Sprite> | undefined;
    if (hitIds?.has(enemy)) return;
    hitIds?.add(enemy);
    const damage = (projectile.getData("damage") as number) ?? 1;
    const splashRadius = (projectile.getData("splashRadius") as number) ?? 0;
    this.damageEnemy(enemy, damage);
    if (splashRadius > 0) this.damageInRadius(enemy.x, enemy.y, splashRadius, Math.max(1, Math.round(damage * 0.46)), enemy);
    const pierce = (projectile.getData("pierce") as number) ?? 0;
    if (pierce > 0) projectile.setData("pierce", pierce - 1);
    else this.disableProjectile(projectile);
  }

  private damageEnemy(enemy: Phaser.Physics.Arcade.Sprite, rawDamage: number): void {
    if (!enemy.active) return;
    const data = this.enemyData(enemy);
    let damage = Math.max(1, Math.round(rawDamage));
    if (this.progression.has("swordsman-execution") && data.hp / data.maxHp <= 0.3) damage = Math.round(damage * 1.6);
    if (this.progression.has("archer-sniper")) {
      const distance = Phaser.Math.Distance.Between(this.player.x, this.player.y, enemy.x, enemy.y);
      damage = Math.round(damage * (1 + Math.min(0.55, Math.max(0, distance - 180) / 520)));
    }
    if (this.progression.has("base-link") && Phaser.Math.Distance.Between(this.player.x, this.player.y, WORLD.base.x, WORLD.base.y) <= 360) {
      damage = Math.round(damage * 1.3);
    }
    data.hp -= damage;
    this.stats.damage += damage;
    if (data.kind === "boss") this.stats.bossDamage += damage;
    enemy.setTintFill(0xffffff);
    this.time.delayedCall(55, () => enemy.active && enemy.clearTint());
    this.spawnDamageText(enemy.x, enemy.y - 18, damage, data.kind === "boss");
    if (data.hp <= 0) this.killEnemy(enemy, data);
  }

  private killEnemy(enemy: Phaser.Physics.Arcade.Sprite, data: EnemyData): void {
    const x = enemy.x;
    const y = enemy.y;
    enemy.disableBody(true, true);
    this.stats.kills += 1;
    this.gold += data.rewardGold;
    if (data.kind === "gate" && data.gateId) {
      this.gatesDestroyed += 1;
      this.stats.gatesDestroyed = this.gatesDestroyed;
      this.gateSprites.delete(data.gateId);
      this.children.list
        .filter((child) => child.name === "gate-label" && child.getData("gateId") === data.gateId)
        .forEach((child) => child.destroy());
      this.currentMessage = `게이트 파괴 ${this.gatesDestroyed}/3 · 웨이포인트가 연결되었습니다.`;
      this.gold += 30;
      this.spawnImpact(x, y, 125, 0xd073ff);
    } else if (data.kind === "boss") {
      this.spawnImpact(x, y, 240, 0xff8ed8);
      this.finishGame("victory", "신참 용사 파티가 5일 안에 마왕을 쓰러뜨렸습니다!");
      return;
    } else {
      this.spawnImpact(x, y, data.kind === "elite" ? 70 : 28, data.kind === "elite" ? 0xc889e5 : 0x8fd99d);
      if (data.kind === "elite") {
        this.gold += 25;
        this.currentMessage = "히든 몬스터 격파! 에픽 장비 효과로 공격력이 상승했습니다.";
        this.progression.stats.attack += 2;
      }
    }

    const leveled = this.progression.addXp(data.rewardXp);
    if (leveled && !this.awaitingUpgrade) this.offerUpgrade();
  }

  private damageInRadius(
    x: number,
    y: number,
    radius: number,
    damage: number,
    ignored?: Phaser.Physics.Arcade.Sprite,
  ): void {
    for (const child of this.enemies.getChildren()) {
      const enemy = child as Phaser.Physics.Arcade.Sprite;
      if (!enemy.active || enemy === ignored) continue;
      if (Phaser.Math.Distance.Between(x, y, enemy.x, enemy.y) <= radius) this.damageEnemy(enemy, damage);
    }
  }

  private damagePlayer(rawDamage: number): void {
    if (this.playerDead || this.time.now < this.invulnerableUntil || this.ended) return;
    const damage = Math.max(1, Math.round(rawDamage - this.progression.stats.defense));
    this.progression.stats.hp -= damage;
    this.player.setTintFill(0xff8eaa);
    this.cameras.main.shake(80, 0.003);
    this.time.delayedCall(70, () => this.player.active && this.player.clearTint());
    if (this.progression.stats.hp <= 0) this.handlePlayerDeath();
  }

  private handlePlayerDeath(): void {
    if (this.playerDead || this.ended) return;
    this.playerDead = true;
    this.stats.deaths += 1;
    this.gold = Math.max(0, Math.floor(this.gold * 0.85));
    this.player.setVelocity(0).setVisible(false);
    this.currentMessage = "쓰러졌습니다. 공용 골드 15%를 잃고 5초 후 부활합니다.";

    if (this.session.phase === "boss") {
      if (this.retreatUsed) {
        this.finishGame("defeat", "두 번째 마왕전 전멸로 원정이 끝났습니다.");
        return;
      }
      this.retreatUsed = true;
      this.time.delayedCall(5000, () => {
        if (this.ended) return;
        this.clearBossEncounter();
        this.session.resumeAfterRetreat();
        this.respawnAtBase();
        this.currentMessage = "후퇴 기회를 사용했습니다. 60초 안에 정비하고 다시 도전하세요.";
      });
      return;
    }

    this.time.delayedCall(5000, () => this.respawnAtBase());
  }

  private respawnAtBase(): void {
    if (this.ended) return;
    this.playerDead = false;
    this.progression.stats.hp = this.progression.stats.maxHp;
    this.player.setPosition(WORLD.base.x + 120, WORLD.base.y).setVisible(true).setActive(true).clearTint();
    this.invulnerableUntil = this.time.now + 1600;
  }

  private damageBase(rawDamage: number): void {
    if (this.ended || this.session.phase === "boss") return;
    this.baseHp -= Math.max(1, Math.round(rawDamage));
    this.core.setTintFill(0xff7d9b);
    this.time.delayedCall(75, () => this.core.active && this.core.clearTint());
    if (this.baseHp <= 0) this.finishGame("defeat", "베이스캠프가 마왕군에게 파괴되었습니다.");
    else if (this.baseHp <= WORLD.base.maxHp * 0.25) this.currentMessage = "경고: 베이스 내구도 25% 이하! 즉시 귀환하세요.";
  }

  private offerUpgrade(): void {
    this.awaitingUpgrade = true;
    const choices = draftUpgrades(this.options.heroClass, this.progression.stacks, this.progression.level).map((choice) => ({
      ...choice,
      stack: (this.progression.stacks.get(choice.id) ?? 0) + 1,
    }));
    gameBridge.emit("upgrade", choices);
    this.currentMessage = `팀 레벨 ${this.progression.level}! 성장을 선택하세요.`;
  }

  private chooseUpgrade(id: UpgradeId): void {
    if (!this.awaitingUpgrade || !UPGRADE_MAP.has(id)) return;
    this.progression.applyUpgrade(id);
    this.progression.stats.hp = Math.min(this.progression.stats.maxHp, this.progression.stats.hp + 10);
    this.awaitingUpgrade = false;
    this.currentMessage = `${UPGRADE_MAP.get(id)?.name ?? "성장"} 획득. 빌드가 한 단계 진화했습니다.`;
  }

  private tryBuildAt(worldX: number, worldY: number): void {
    const bounds = WORLD.buildBounds;
    if (worldX < bounds.minX || worldX > bounds.maxX || worldY < bounds.minY || worldY > bounds.maxY) {
      this.currentMessage = "건설은 베이스의 청록색 그리드 안에서만 가능합니다.";
      return;
    }
    const x = Math.round(worldX / WORLD.gridSize) * WORLD.gridSize;
    const y = Math.round(worldY / WORLD.gridSize) * WORLD.gridSize;

    if (this.buildMode === "upgrade") {
      this.upgradeStructureAt(x, y);
      return;
    }

    if (!this.buildMode) return;
    const cost = BUILDINGS[this.buildMode].cost;
    if (this.gold < cost) {
      this.currentMessage = `골드가 부족합니다. ${cost}G가 필요합니다.`;
      return;
    }
    const occupied = this.structures.getChildren().some((child) => {
      const structure = child as Phaser.Physics.Arcade.Image;
      return Phaser.Math.Distance.Between(x, y, structure.x, structure.y) < 34;
    });
    if (occupied || Phaser.Math.Distance.Between(x, y, WORLD.base.x, WORLD.base.y) < 92) {
      this.currentMessage = "다른 시설 또는 코어와 겹치지 않는 칸을 선택하세요.";
      return;
    }

    const kind = this.buildMode;
    const structure = this.structures.create(x, y, kind) as Phaser.Physics.Arcade.Image;
    const maxHp = kind === "wall" ? 130 : 82;
    const data: StructureData = { kind, level: 1, hp: maxHp, maxHp, nextShotAt: 0 };
    structure.setData("structure", data).setDepth(5);
    structure.refreshBody();
    this.gold -= cost;
    this.stats.goldSpent += cost;
    this.stats.structuresBuilt += 1;
    this.currentMessage = `${kind === "turret" ? "포탑" : "장벽"} 건설 완료. 클릭으로 계속 배치할 수 있습니다.`;
    this.spawnImpact(x, y, 42, 0x9adcc1);
  }

  private upgradeStructureAt(x: number, y: number): void {
    let nearest: Phaser.Physics.Arcade.Image | null = null;
    let nearestDistance = 60;
    for (const child of this.structures.getChildren()) {
      const structure = child as Phaser.Physics.Arcade.Image;
      const distance = Phaser.Math.Distance.Between(x, y, structure.x, structure.y);
      if (distance < nearestDistance) {
        nearest = structure;
        nearestDistance = distance;
      }
    }
    if (!nearest) {
      this.currentMessage = "업그레이드할 시설을 클릭하세요.";
      return;
    }
    const data = nearest.getData("structure") as StructureData;
    const definition = BUILDINGS[data.kind];
    if (data.level >= definition.maxLevel) {
      this.currentMessage = "이미 3레벨까지 강화된 시설입니다.";
      return;
    }
    const nextLevel = data.level + 1;
    const cost = definition.upgradeCost[nextLevel - 1];
    if (this.gold < cost) {
      this.currentMessage = `업그레이드에 ${cost}G가 필요합니다.`;
      return;
    }
    this.gold -= cost;
    this.stats.goldSpent += cost;
    data.level = nextLevel;
    data.maxHp = Math.round(data.maxHp * 1.55);
    data.hp = data.maxHp;
    nearest.setScale(1 + (nextLevel - 1) * 0.12).setTint(nextLevel === 2 ? 0xc2dfd0 : 0xffe594).setAlpha(1);
    nearest.refreshBody();
    this.currentMessage = `${data.kind === "turret" ? "포탑" : "장벽"} ${nextLevel}레벨 강화 완료.`;
    this.spawnImpact(nearest.x, nearest.y, 52, nextLevel === 3 ? 0xffd66e : 0x9adcc1);
  }

  private enterBoss(): void {
    if (this.session.phase === "boss" || this.ended) return;
    if (this.gatesDestroyed < 3 || this.session.day < 3) {
      this.currentMessage = "3일차 이후 세 게이트를 모두 파괴해야 마왕방에 입장할 수 있습니다.";
      return;
    }
    this.session.startBoss();
    this.buildMode = null;
    this.player.setPosition(WORLD.arena.x, WORLD.arena.y + 205);
    this.allies.forEach((ally, index) => ally.setPosition(WORLD.arena.x + (index === 0 ? -65 : 65), WORLD.arena.y + 220));
    this.clearNonBossEnemies();
    this.boss = this.spawnEnemy("boss", WORLD.arena.x, WORLD.arena.y - 60, false, 3);
    this.boss.setImmovable(true).setDepth(8);
    this.bossPatternAt = this.time.now + 1100;
    this.bossGroundAt = this.time.now + 2600;
    this.bossSummonAt = this.time.now + 5200;
    this.currentMessage = "마왕전 개시. 탄막과 장판을 피하며 성장의 결과를 증명하세요!";
    this.cameras.main.flash(300, 135, 55, 142);
  }

  private returnToBase(): void {
    if (this.session.phase === "boss" || this.playerDead) return;
    this.player.setPosition(WORLD.base.x + 120, WORLD.base.y);
    this.allies.forEach((ally, index) => ally.setPosition(WORLD.base.x + 80, WORLD.base.y + (index === 0 ? -55 : 55)));
    this.currentMessage = "웨이포인트 귀환 완료. 시설을 건설하거나 다시 원정하세요.";
    this.spawnImpact(this.player.x, this.player.y, 80, 0x9adcc1);
  }

  private spawnGroundWarning(x: number, y: number, radius: number, damage: number, friendly = false): void {
    const color = friendly ? 0xc69bff : 0xff4f86;
    const warning = this.add.circle(x, y, radius, color, 0.08).setStrokeStyle(3, color, 0.9).setDepth(7);
    this.tweens.add({ targets: warning, alpha: 0.42, scale: 0.92, yoyo: true, repeat: 2, duration: 170 });
    this.time.delayedCall(friendly ? 520 : 850, () => {
      if (!warning.active || this.ended) return;
      if (friendly) this.damageInRadius(x, y, radius, damage);
      else if (Phaser.Math.Distance.Between(x, y, this.player.x, this.player.y) <= radius) this.damagePlayer(damage);
      this.spawnImpact(x, y, radius, color);
      warning.destroy();
    });
  }

  private spawnImpact(x: number, y: number, radius: number, color: number): void {
    const impact = this.add.circle(x, y, Math.max(8, radius * 0.25), color, 0.28).setStrokeStyle(3, color, 0.85).setDepth(15);
    this.tweens.add({ targets: impact, radius, alpha: 0, duration: 260, ease: "Quad.easeOut", onComplete: () => impact.destroy() });
  }

  private spawnDamageText(x: number, y: number, damage: number, critical: boolean): void {
    const text = this.add
      .text(x, y, `${damage}`, {
        fontFamily: "monospace",
        fontSize: critical ? "18px" : "13px",
        fontStyle: "bold",
        color: critical ? "#ff9bd1" : "#fff0b1",
        stroke: "#19151a",
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setDepth(30);
    this.tweens.add({ targets: text, y: y - 28, alpha: 0, duration: 480, onComplete: () => text.destroy() });
  }

  private flashCamera(color: number, duration: number): void {
    const r = (color >> 16) & 255;
    const g = (color >> 8) & 255;
    const b = color & 255;
    this.cameras.main.flash(duration, r, g, b, false);
  }

  private clampPlayerToArena(): void {
    const vector = new Phaser.Math.Vector2(this.player.x - WORLD.arena.x, this.player.y - WORLD.arena.y);
    const maxDistance = WORLD.arena.radius - 24;
    if (vector.length() > maxDistance) {
      vector.normalize().scale(maxDistance);
      this.player.setPosition(WORLD.arena.x + vector.x, WORLD.arena.y + vector.y);
    }
  }

  private limitPointToRange(worldX: number, worldY: number, range: number): Phaser.Math.Vector2 {
    const vector = new Phaser.Math.Vector2(worldX - this.player.x, worldY - this.player.y);
    if (vector.length() > range) vector.normalize().scale(range);
    return new Phaser.Math.Vector2(this.player.x + vector.x, this.player.y + vector.y);
  }

  private enemyData(enemy: Phaser.Physics.Arcade.Sprite): EnemyData {
    return enemy.getData("enemy") as EnemyData;
  }

  private disableProjectile(projectile: Phaser.Physics.Arcade.Image): void {
    projectile.disableBody(true, true);
    projectile.setData("hitIds", undefined);
  }

  private clearNonBossEnemies(): void {
    for (const child of this.enemies.getChildren()) {
      const enemy = child as Phaser.Physics.Arcade.Sprite;
      if (!enemy.active) continue;
      const data = this.enemyData(enemy);
      if (data.kind !== "boss") enemy.disableBody(true, true);
    }
    this.gateSprites.clear();
  }

  private clearBossEncounter(): void {
    for (const child of this.enemies.getChildren()) {
      const enemy = child as Phaser.Physics.Arcade.Sprite;
      if (enemy.active) enemy.disableBody(true, true);
    }
    for (const child of this.enemyProjectiles.getChildren()) this.disableProjectile(child as Phaser.Physics.Arcade.Image);
    this.boss = undefined;
  }

  private finishGame(state: "victory" | "defeat", reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.session.end();
    this.physics.pause();
    const result: GameResult = {
      state,
      reason,
      elapsed: this.session.elapsed,
      day: Math.min(5, this.session.day),
      level: this.progression.level,
      teamPower: this.progression.powerScore,
      stats: { ...this.stats },
    };
    gameBridge.emit("result", result);
    this.emitSnapshot();
  }

  private handleCommand(command: GameCommand): void {
    if (command.type === "choose-upgrade") this.chooseUpgrade(command.upgradeId);
    else if (command.type === "set-build-mode") {
      this.buildMode = command.buildMode;
      this.currentMessage = command.buildMode
        ? command.buildMode === "upgrade"
          ? "강화할 시설을 클릭하세요."
          : `${command.buildMode === "turret" ? "포탑" : "장벽"} 배치 위치를 베이스 그리드에서 클릭하세요.`
        : "건설 모드를 종료했습니다.";
    } else if (command.type === "enter-boss") this.enterBoss();
    else if (command.type === "return-base") this.returnToBase();
  }

  private emitSnapshot(): void {
    const bossData = this.boss?.active ? this.enemyData(this.boss) : null;
    const upgrades = [...this.progression.stacks.entries()]
      .map(([id, stack]) => ({ name: UPGRADE_MAP.get(id)?.name ?? id, stack }))
      .slice(-4);
    const snapshot: GameSnapshot = {
      running: !this.ended,
      phase: this.session.phase,
      phaseLabel: PHASE_LABELS[this.session.phase],
      day: Math.min(5, this.session.day),
      phaseRemaining: Math.max(0, this.session.phaseRemaining),
      elapsed: this.session.elapsed,
      hp: Math.max(0, this.progression.stats.hp),
      maxHp: this.progression.stats.maxHp,
      baseHp: Math.max(0, this.baseHp),
      baseMaxHp: WORLD.base.maxHp,
      level: this.progression.level,
      xp: this.progression.xp,
      xpToNext: this.progression.xpToNext,
      gold: this.gold,
      teamPower: this.progression.powerScore,
      gatesDestroyed: this.gatesDestroyed,
      buildMode: this.buildMode,
      qCooldown: Math.max(0, (this.qReadyAt - this.time.now) / 1000),
      eCooldown: Math.max(0, (this.eReadyAt - this.time.now) / 1000),
      dashCooldown: Math.max(0, (this.dashReadyAt - this.time.now) / 1000),
      bossAvailable: this.gatesDestroyed >= 3 && this.session.day >= 3 && this.session.phase !== "boss",
      bossHp: bossData ? Math.max(0, bossData.hp) : null,
      bossMaxHp: bossData?.maxHp ?? null,
      message: this.currentMessage,
      upgrades,
      stats: { ...this.stats },
    };
    gameBridge.emit("snapshot", snapshot);
  }

  private cleanup(): void {
    this.commandDisconnect?.();
    this.commandDisconnect = undefined;
    this.input.removeAllListeners();
  }
}
