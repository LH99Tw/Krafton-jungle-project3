import * as Phaser from "phaser";
import { createSeededRandom, enemyFanPatternAngles, enemyFloorPatternCircles, enemyPatternConfig, type EnemyPatternTier } from "@five-days/game-core";
import { CLASS_DEFINITIONS } from "../../content/classes";
import type { HeroClassId, NetworkWorldSnapshot, PartyMemberSnapshot } from "../../domain/types";
import { createGameTextures } from "../../client/render/createTextures";
import { combatSoundKey, type CombatSoundAction } from "../../client/audio/combatSounds";
import {
  BASIC_ATTACK_SPRITE_SETS,
  SWORDSMAN_SLASH_DIRECTIONS,
  basicAttackSpriteForLevel,
  swordsmanSlashAnimationDirectionForAim,
} from "../../client/render/attackEffectSprites";
import {
  DEFAULT_HERO_FACING,
  HERO_SPRITE_SCALE,
  heroFacingForAim,
  heroFacingForMovement,
  heroFacingForPose,
  heroFrameForPose,
  type HeroFacingDirection,
} from "../../client/render/heroSprites";
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

export type ProgressionBarrier = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
  kind: "progression" | "trap";
}>;

const ENEMY_LOOK = {
  static: { texture: "enemy-skeleton-0", depth: 12, radius: 11 },
  invader: { texture: "enemy-skeleton-0", depth: 12, radius: 11 },
  hidden: { texture: "enemy-demon-midboss-0", depth: 16, radius: 64 },
  gate: { texture: "gate", depth: 12, radius: 26 },
  boss: { texture: "boss", depth: 18, radius: 72 },
} as const;
const NETWORK_ENEMY_POOL_LIMIT: Record<EnemyKind, number> = {
  invader: 256,
  static: 64,
  hidden: 32,
  gate: 8,
  boss: 2,
};
const UNIT_RENDER_SCALE = 1.3;
const MIDBOSS_DISPLAY_SIZE = 192 * UNIT_RENDER_SCALE;
const GATE_DISPLAY_WIDTH = 112 * UNIT_RENDER_SCALE;
const GATE_DISPLAY_HEIGHT = 130 * UNIT_RENDER_SCALE;
const BOSS_DISPLAY_SIZE = 250 * UNIT_RENDER_SCALE;

const CRITICAL_ATTACK_COLORS: Record<HeroClassId, number> = {
  swordsman: 0xd8f6ff,
  archer: 0xff9d2e,
  mage: 0xff4df0,
};

const ROOM_NAMES: Record<RenderableRoom["type"], string> = {
  start: "원정대 야영지",
  gate: "균열 관문",
  "gate-candidate": "불안정 균열",
  resource: "고대 채집지",
  "static-monster": "봉인된 사냥터",
  empty: "고요한 방",
  "central-waypoint": "중앙 웨이포인트",
  "hidden-monster": "숨겨진 시련",
  boss: "마왕의 제단",
  shop: "떠돌이 상단",
  shrine: "메아리의 성소",
  trap: "몬스터 하우스",
  checkpoint: "귀환의 마법진",
  gamble: "운명의 도박장",
  altar: "피의 제단",
  gold: "봉인된 황금 금고",
};

const SPECIAL_ROOM_OBJECTS: Partial<Record<RenderableRoom["type"], Readonly<{
  texture: string;
  maxWidth: number;
  maxHeight: number;
  yOffset: number;
}>>> = {
  shop: { texture: "special-room-shop", maxWidth: 360, maxHeight: 310, yOffset: 34 },
  shrine: { texture: "special-room-shrine", maxWidth: 300, maxHeight: 300, yOffset: 24 },
  trap: { texture: "special-room-trap", maxWidth: 350, maxHeight: 350, yOffset: 28 },
  checkpoint: { texture: "special-room-checkpoint", maxWidth: 250, maxHeight: 310, yOffset: 24 },
  gamble: { texture: "special-room-gamble", maxWidth: 230, maxHeight: 345, yOffset: 28 },
  altar: { texture: "special-room-altar", maxWidth: 340, maxHeight: 300, yOffset: 34 },
  gold: { texture: "resource-gold-pickup", maxWidth: 180, maxHeight: 180, yOffset: 28 },
};

export class RoomRenderer {
  private roomObjects: Phaser.GameObjects.GameObject[] = [];
  private readonly resourcePickups = new Map<string, Phaser.GameObjects.Image>();
  private waypointObjects: Phaser.GameObjects.GameObject[] = [];
  private roomMasks: Phaser.Display.Masks.GeometryMask[] = [];
  private readonly enemyPatternObjects = new Map<string, { key: string; graphics: Phaser.GameObjects.Graphics }>();
  private readonly networkEnemyPool = new Map<EnemyKind, Phaser.GameObjects.Sprite[]>();
  private readonly specialRoomObjects = new Map<string, Phaser.GameObjects.Image>();
  private claimedShrineIds = new Set<string>();
  private specialRoomStateInitialized = false;
  private readonly transitioningShrineIds = new Set<string>();
  private previousSpecialRoomStates = new Map<string, { trapPhase: string; goldClaimed: boolean }>();
  private previousShopOfferSignature = "";
  private previousShopRoomId = "";
  private previousGambleAttempts = 0;
  private previousAltarAttempts = 0;
  private previousRespawnRoomId = "";
  private progressionBarrierObjects: Phaser.GameObjects.GameObject[] = [];
  private progressionBarrierTweens: Phaser.Tweens.Tween[] = [];
  private progressionBarrierKey = "";
  private readonly revealedTrapObjects = new Map<string, Phaser.GameObjects.GameObject[]>();
  private readonly heroStatusEffects = new Map<string, {
    key: string;
    outlines: Phaser.GameObjects.Sprite[];
    label: Phaser.GameObjects.Text;
  }>();
  private crosshair!: Phaser.GameObjects.Image;

  constructor(private readonly scene: Phaser.Scene) {}

  create(): void {
    createGameTextures(this.scene);
    this.createBasicAttackAnimations();
    this.createVegetationFrames();
    this.createEnvironmentFrames();
    this.createCrosshairTexture();
    this.crosshair = this.scene.add.image(640, 360, "medieval-crosshair").setDepth(200).setScrollFactor(0);
    this.scene.game.canvas.style.cursor = "none";
  }

  private createBasicAttackAnimations(): void {
    for (const slash of BASIC_ATTACK_SPRITE_SETS.swordsman) {
      for (const [row, direction] of SWORDSMAN_SLASH_DIRECTIONS.entries()) {
        const key = `${slash.animationKey}-${direction}`;
        if (this.scene.anims.exists(key)) continue;
        this.scene.anims.create({
          key,
          frames: this.scene.anims.generateFrameNumbers(slash.textureKey, {
            start: row * slash.frameCount,
            end: (row + 1) * slash.frameCount - 1,
          }),
          frameRate: slash.frameRate,
          repeat: slash.repeat,
        });
      }
    }
    for (const classId of ["archer", "mage"] as const) {
      for (const sprite of BASIC_ATTACK_SPRITE_SETS[classId]) {
        if (this.scene.anims.exists(sprite.animationKey)) continue;
        this.scene.anims.create({
          key: sprite.animationKey,
          frames: this.scene.anims.generateFrameNumbers(sprite.textureKey, {
            start: 0,
            end: sprite.frameCount - 1,
          }),
          frameRate: sprite.frameRate,
          repeat: sprite.repeat,
        });
      }
    }
  }

  /**
   * Draws a whole zone as one continuous world: rooms fill world rectangles and
   * connected rooms are joined by paved walkway corridors (통로). Non-walkable
   * gaps render as walls, so the world reads as a seamless, connected map.
   */
  renderWorld(world: RenderZoneWorld, options: {
    decorSeed: string;
    showBuildGrid: boolean;
    waypointRooms: ReadonlySet<string>;
    revealedTrapRooms?: ReadonlySet<string>;
  }): void {
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
    for (const corridor of world.corridors) this.drawWalkway(graphics, corridor, zone);

    // Rooms.
    for (const entry of world.rooms) {
      this.drawWorldRoom(graphics, entry, palette, options, options.decorSeed);
    }

    if (world.wallSegments.length > 0) this.drawAutomaticWalls(graphics, world.wallSegments);

    // Procedural terrain decor (bushes/rocks) for map-template variety.
    this.drawWorldDecor(world, options.decorSeed);
    this.updateWaypoints(world, options.waypointRooms);
  }

  updateWaypoints(world: RenderZoneWorld, waypointRooms: ReadonlySet<string>): void {
    for (const object of this.waypointObjects) object.destroy();
    this.waypointObjects = [];
    for (const entry of world.rooms) {
      if (!waypointRooms.has(entry.room.id)) continue;
      const { room, center } = entry;
      const label = room.type === "gate"
        ? room.zone === 3 ? "마왕전 진입 웨이포인트" : "다음 구역 웨이포인트"
        : room.type === "central-waypoint" ? "중앙 귀환 웨이포인트" : "귀환 웨이포인트";
      this.waypointObjects.push(
        this.scene.add.circle(center.x, center.y, 42, 0x8de5c1, 0.15).setStrokeStyle(3, 0xb8f5dc, 0.92).setDepth(2),
        this.scene.add.text(center.x, center.y + 58, label, {
          fontFamily: "sans-serif",
          fontSize: "11px",
          color: "#bdf5de",
          backgroundColor: "#13211dcc",
          padding: { x: 7, y: 4 },
        }).setOrigin(0.5).setDepth(3),
      );
    }
  }

  updateSpecialRoomStates(
    snapshot: Pick<NetworkWorldSnapshot, "seed" | "specialRooms" | "shopOffers">,
    localPlayer?: PartyMemberSnapshot,
  ): void {
    const states = snapshot.specialRooms;
    const wasInitialized = this.specialRoomStateInitialized;
    const nextClaimedShrines = new Set(
      states.filter((state) => state.kind === "shrine" && Boolean(state.shrineClaimedBy)).map((state) => state.roomId),
    );
    for (const [roomId, image] of this.specialRoomObjects) {
      if (image.getData("specialRoomKind") !== "shrine") continue;
      const claimed = nextClaimedShrines.has(roomId);
      const previouslyClaimed = this.claimedShrineIds.has(roomId);
      if (!claimed) {
        if (!this.transitioningShrineIds.has(roomId)) image.setTexture("special-room-shrine").clearTint().setAlpha(1);
        continue;
      }
      if (image.texture.key === "special-room-shrine-used" || this.transitioningShrineIds.has(roomId)) continue;
      if (!this.specialRoomStateInitialized || previouslyClaimed) {
        image.setTexture("special-room-shrine-used").clearTint().setAlpha(1);
        continue;
      }
      this.playShrineClaimTransition(roomId, image);
    }

    const nextSpecialStates = new Map<string, { trapPhase: string; goldClaimed: boolean }>();
    for (const state of states) {
      const nextState = { trapPhase: state.trapPhase, goldClaimed: state.goldClaimed };
      nextSpecialStates.set(state.roomId, nextState);
      const image = this.specialRoomObjects.get(state.roomId);
      if (!image) continue;
      const previous = this.previousSpecialRoomStates.get(state.roomId);
      if (state.kind === "gold") {
        image.setAlpha(state.goldClaimed ? 0.38 : 1).setTint(state.goldClaimed ? 0x777777 : 0xffffff);
        if (wasInitialized && state.goldClaimed && !previous?.goldClaimed) this.playGoldClaimEffect(image);
      }
      if (wasInitialized && state.kind === "trap" && previous?.trapPhase !== state.trapPhase) {
        this.playTrapPhaseEffect(image, state.trapPhase);
      }
    }

    const shopOfferSignature = [...snapshot.shopOffers]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((offer) => `${offer.id}:${offer.sold ? 1 : 0}:${offer.locked ? 1 : 0}:${offer.price}`)
      .join("|");
    const shopRoomId = snapshot.shopOffers[0]?.roomId ?? this.previousShopRoomId;
    if (wasInitialized && shopOfferSignature && this.previousShopOfferSignature && shopOfferSignature !== this.previousShopOfferSignature) {
      const image = this.specialRoomObjects.get(shopRoomId);
      if (image) this.playShopEffect(image);
    }

    if (localPlayer) {
      const gambleAttempts = localPlayer.gambleAttempts ?? 0;
      if (wasInitialized && gambleAttempts > this.previousGambleAttempts) {
        const image = this.specialRoomObjects.get(localPlayer.roomId);
        if (image?.getData("specialRoomKind") === "gamble") {
          const attempt = gambleAttempts - 1;
          const roll = createSeededRandom(`gamble:${snapshot.seed}:${localPlayer.roomId}:${localPlayer.userId}:${attempt}`).next();
          this.playGambleEffect(image, roll >= 0.5);
        }
      }
      const altarAttempts = localPlayer.altarAttempts ?? 0;
      if (wasInitialized && altarAttempts > this.previousAltarAttempts) {
        const image = this.specialRoomObjects.get(localPlayer.roomId);
        if (image?.getData("specialRoomKind") === "altar") this.playAltarEffect(image);
      }
      const respawnRoomId = localPlayer.respawnRoomId ?? "";
      if (wasInitialized && respawnRoomId && respawnRoomId !== this.previousRespawnRoomId) {
        const image = this.specialRoomObjects.get(respawnRoomId);
        if (image?.getData("specialRoomKind") === "checkpoint") this.playCheckpointEffect(image);
      }
      this.previousGambleAttempts = gambleAttempts;
      this.previousAltarAttempts = altarAttempts;
      this.previousRespawnRoomId = respawnRoomId;
    }

    this.claimedShrineIds = nextClaimedShrines;
    this.previousSpecialRoomStates = nextSpecialStates;
    this.previousShopOfferSignature = shopOfferSignature;
    this.previousShopRoomId = shopRoomId;
    this.specialRoomStateInitialized = true;
  }

  private playShrineClaimTransition(roomId: string, image: Phaser.GameObjects.Image): void {
    this.transitioningShrineIds.add(roomId);
    const baseScaleX = image.scaleX;
    const baseScaleY = image.scaleY;
    const flare = this.track(this.scene.add.image(image.x, image.y, "special-room-shrine")
      .setScale(baseScaleX, baseScaleY)
      .setTint(0xc58aff)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setAlpha(0.62)
      .setDepth(image.depth + 1));
    this.scene.tweens.add({
      targets: flare,
      alpha: 0,
      scaleX: baseScaleX * 1.16,
      scaleY: baseScaleY * 1.16,
      duration: 420,
      ease: "Cubic.easeOut",
      onComplete: () => flare.destroy(),
    });
    this.scene.tweens.add({
      targets: image,
      alpha: 0,
      scaleX: baseScaleX * 0.9,
      scaleY: baseScaleY * 0.9,
      duration: 230,
      ease: "Cubic.easeIn",
      onComplete: () => {
        if (!image.active) {
          this.transitioningShrineIds.delete(roomId);
          return;
        }
        image.setTexture("special-room-shrine-used").clearTint();
        this.scene.tweens.add({
          targets: image,
          alpha: 1,
          scaleX: baseScaleX,
          scaleY: baseScaleY,
          duration: 430,
          ease: "Back.easeOut",
          onComplete: () => this.transitioningShrineIds.delete(roomId),
        });
      },
    });
  }

  private playShopEffect(image: Phaser.GameObjects.Image): void {
    this.playObjectPulse(image, 0xffd66e);
    this.playSparkBurst(image, 0xffd66e, 9, 88);
  }

  private playTrapPhaseEffect(image: Phaser.GameObjects.Image, phase: string): void {
    if (phase === "cleared") {
      this.playObjectPulse(image, 0x8fffc7, 560);
      this.playSparkBurst(image, 0x8fffc7, 12, 118);
      return;
    }
    if (!["warning", "wave", "hidden"].includes(phase)) return;
    this.playObjectPulse(image, 0xff3b49, 420);
    const originX = image.x;
    this.scene.tweens.add({
      targets: image,
      x: originX + 9,
      duration: 58,
      yoyo: true,
      repeat: 4,
      ease: "Sine.easeInOut",
      onComplete: () => image.active && image.setX(originX),
    });
  }

  private playCheckpointEffect(image: Phaser.GameObjects.Image): void {
    this.playObjectPulse(image, 0x9d8cff, 680);
    this.playSparkBurst(image, 0xc7bdff, 14, 126);
  }

  private playGambleEffect(image: Phaser.GameObjects.Image, success: boolean): void {
    if (success) {
      this.playObjectPulse(image, 0xffd35c, 620);
      this.playSparkBurst(image, 0xffe487, 18, 148);
      const originY = image.y;
      this.scene.tweens.add({
        targets: image,
        y: originY - 18,
        duration: 170,
        yoyo: true,
        ease: "Back.easeOut",
        onComplete: () => image.active && image.setY(originY),
      });
      return;
    }
    this.playObjectPulse(image, 0xb52d3e, 460);
    const originX = image.x;
    this.scene.tweens.add({
      targets: image,
      x: originX + 11,
      angle: { from: -2, to: 2 },
      duration: 62,
      yoyo: true,
      repeat: 4,
      ease: "Sine.easeInOut",
      onComplete: () => image.active && image.setPosition(originX, image.y).setAngle(0),
    });
    for (let index = 0; index < 7; index += 1) {
      const smoke = this.track(this.scene.add.circle(
        image.x + (index - 3) * 11,
        image.y - 10,
        10 + index % 3 * 4,
        0x2b2028,
        0.72,
      ).setDepth(image.depth + 2));
      this.scene.tweens.add({
        targets: smoke,
        y: smoke.y - 58 - index * 5,
        x: smoke.x + (index % 2 === 0 ? -18 : 18),
        alpha: 0,
        scale: 1.65,
        delay: index * 34,
        duration: 520,
        ease: "Cubic.easeOut",
        onComplete: () => smoke.destroy(),
      });
    }
  }

  private playAltarEffect(image: Phaser.GameObjects.Image): void {
    this.playObjectPulse(image, 0xd21f3c, 520);
    for (let index = 0; index < 12; index += 1) {
      const offsetX = ((index * 23) % 112) - 56;
      const drop = this.track(this.scene.add.ellipse(
        image.x + offsetX,
        image.y - 20 + index % 3 * 8,
        7,
        15,
        index % 2 === 0 ? 0xa90822 : 0x5d0714,
        0.9,
      ).setDepth(image.depth + 3));
      this.scene.tweens.add({
        targets: drop,
        y: drop.y + 86 + index * 3,
        alpha: 0,
        scaleY: 1.7,
        delay: index * 28,
        duration: 480,
        ease: "Quad.easeIn",
        onComplete: () => drop.destroy(),
      });
    }
  }

  private playGoldClaimEffect(image: Phaser.GameObjects.Image): void {
    this.playObjectPulse(image, 0xffdd5b, 720);
    this.playSparkBurst(image, 0xffe98a, 22, 176);
    this.scene.tweens.add({ targets: image, alpha: 0.38, duration: 620, ease: "Cubic.easeOut" });
  }

  private playObjectPulse(image: Phaser.GameObjects.Image, color: number, duration = 520): void {
    if (!image.active) return;
    const pulse = this.track(this.scene.add.image(image.x, image.y, image.texture.key)
      .setScale(image.scaleX, image.scaleY)
      .setTint(color)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setAlpha(0.68)
      .setDepth(image.depth + 1));
    this.scene.tweens.add({
      targets: pulse,
      alpha: 0,
      scaleX: image.scaleX * 1.18,
      scaleY: image.scaleY * 1.18,
      duration,
      ease: "Cubic.easeOut",
      onComplete: () => pulse.destroy(),
    });
  }

  private playSparkBurst(image: Phaser.GameObjects.Image, color: number, count: number, distance: number): void {
    for (let index = 0; index < count; index += 1) {
      const angle = Math.PI * 2 * index / count;
      const radius = 4 + index % 3;
      const spark = this.track(this.scene.add.star(image.x, image.y, 4, radius * 0.45, radius, color, 0.96)
        .setAngle(index * 31)
        .setDepth(image.depth + 3));
      this.scene.tweens.add({
        targets: spark,
        x: image.x + Math.cos(angle) * distance,
        y: image.y + Math.sin(angle) * distance * 0.62,
        angle: spark.angle + 150,
        alpha: 0,
        scale: 0.2,
        delay: index * 14,
        duration: 520 + index * 9,
        ease: "Cubic.easeOut",
        onComplete: () => spark.destroy(),
      });
    }
  }

  updateProgressionBarriers(barriers: readonly ProgressionBarrier[]): void {
    const key = barriers.map((barrier) => `${barrier.kind}:${barrier.x}:${barrier.y}:${barrier.width}:${barrier.height}`).join("|");
    if (key === this.progressionBarrierKey) return;
    this.progressionBarrierKey = key;
    for (const tween of this.progressionBarrierTweens) tween.remove();
    for (const object of this.progressionBarrierObjects) object.destroy();
    this.progressionBarrierTweens = [];
    this.progressionBarrierObjects = [];
    for (const barrier of barriers) {
      if (barrier.kind === "trap") {
        this.createTrapPortcullis(barrier);
        continue;
      }
      const glow = this.scene.add.rectangle(barrier.x, barrier.y, barrier.width + 18, barrier.height + 18, 0x75ddff, 0.12)
        .setBlendMode(Phaser.BlendModes.ADD).setDepth(24);
      const field = this.scene.add.rectangle(barrier.x, barrier.y, barrier.width, barrier.height, 0x83e4ff, 0.34)
        .setStrokeStyle(3, 0xc8f5ff, 0.92).setBlendMode(Phaser.BlendModes.ADD).setDepth(25);
      const core = this.scene.add.rectangle(barrier.x, barrier.y, Math.max(3, barrier.width * 0.18), Math.max(3, barrier.height * 0.18), 0xe8fbff, 0.82)
        .setBlendMode(Phaser.BlendModes.ADD).setDepth(26);
      this.progressionBarrierObjects.push(glow, field, core);
      this.progressionBarrierTweens.push(
        this.scene.tweens.add({ targets: glow, alpha: { from: 0.08, to: 0.3 }, scaleX: { from: 0.96, to: 1.08 }, scaleY: { from: 0.96, to: 1.08 }, duration: 720, yoyo: true, repeat: -1, ease: "Sine.easeInOut" }),
        this.scene.tweens.add({ targets: core, alpha: { from: 0.35, to: 0.95 }, duration: 430, yoyo: true, repeat: -1, ease: "Sine.easeInOut" }),
      );
    }
  }

  private createTrapPortcullis(barrier: ProgressionBarrier): void {
    const horizontal = barrier.width >= barrier.height;
    const longLength = horizontal ? barrier.width : barrier.height;
    const shortLength = Math.max(30, horizontal ? barrier.height : barrier.width);
    const railInset = Math.min(7, shortLength * 0.2);
    const halfLong = longLength / 2;
    const halfShort = shortLength / 2;
    const bars = this.scene.add.graphics().setPosition(barrier.x, barrier.y).setDepth(27);

    bars.fillStyle(0x08090a, 0.58);
    bars.fillRoundedRect(
      horizontal ? -halfLong - 7 : -halfShort - 7,
      horizontal ? -halfShort - 7 : -halfLong - 7,
      horizontal ? longLength + 14 : shortLength + 14,
      horizontal ? shortLength + 14 : longLength + 14,
      5,
    );

    const drawMetalLine = (x1: number, y1: number, x2: number, y2: number, outerWidth: number): void => {
      bars.lineStyle(outerWidth, 0x17191b, 1);
      bars.lineBetween(x1, y1, x2, y2);
      bars.lineStyle(Math.max(2, outerWidth - 4), 0x625f59, 1);
      bars.lineBetween(x1, y1, x2, y2);
      bars.lineStyle(1, 0xaaa296, 0.72);
      bars.lineBetween(x1 - (horizontal ? 1 : 0), y1 - (horizontal ? 0 : 1), x2 - (horizontal ? 1 : 0), y2 - (horizontal ? 0 : 1));
    };

    if (horizontal) {
      drawMetalLine(-halfLong, -halfShort + railInset, halfLong, -halfShort + railInset, 8);
      drawMetalLine(-halfLong, halfShort - railInset, halfLong, halfShort - railInset, 8);
      for (let offset = -halfLong + 7; offset <= halfLong - 7; offset += 20) {
        drawMetalLine(offset, -halfShort, offset, halfShort, 7);
      }
    } else {
      drawMetalLine(-halfShort + railInset, -halfLong, -halfShort + railInset, halfLong, 8);
      drawMetalLine(halfShort - railInset, -halfLong, halfShort - railInset, halfLong, 8);
      for (let offset = -halfLong + 7; offset <= halfLong - 7; offset += 20) {
        drawMetalLine(-halfShort, offset, halfShort, offset, 7);
      }
    }

    bars.fillStyle(0x2a1d17, 1);
    const postSize = 11;
    const postPositions = horizontal
      ? [[-halfLong, 0], [halfLong, 0]]
      : [[0, -halfLong], [0, halfLong]];
    for (const [x, y] of postPositions) {
      bars.fillRoundedRect(x! - postSize / 2, y! - postSize / 2, postSize, postSize, 2);
      bars.fillStyle(0x9a7b56, 0.9);
      bars.fillCircle(x!, y!, 2.2);
      bars.fillStyle(0x2a1d17, 1);
    }

    this.progressionBarrierObjects.push(bars);
    bars.setAlpha(0.15);
    if (horizontal) bars.setScale(1, 0.12);
    else bars.setScale(0.12, 1);
    this.progressionBarrierTweens.push(this.scene.tweens.add({
      targets: bars,
      alpha: 1,
      scaleX: 1,
      scaleY: 1,
      duration: 260,
      ease: "Back.easeOut",
    }));
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

  private drawWalkway(graphics: Phaser.GameObjects.Graphics, corridor: { x: number; y: number; width: number; height: number }, zone: number): void {
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
  }

  private drawAutomaticWalls(graphics: Phaser.GameObjects.Graphics, walls: RenderZoneWorld["wallSegments"]): void {
    graphics.lineStyle(24, 0x080b09, 0.98);
    for (const wall of walls) graphics.lineBetween(wall.x1, wall.y1, wall.x2, wall.y2);
    graphics.lineStyle(12, 0x29362d, 1);
    for (const wall of walls) graphics.lineBetween(wall.x1, wall.y1, wall.x2, wall.y2);
  }

  private drawWorldRoom(
    graphics: Phaser.GameObjects.Graphics,
    entry: RenderWorldRoom,
    palette: { floor: number; tile: number; wall: number; accent: number },
    options: { showBuildGrid: boolean; waypointRooms: ReadonlySet<string>; revealedTrapRooms?: ReadonlySet<string> },
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

    const trapRevealed = room.type !== "trap" || options.revealedTrapRooms?.has(room.id) === true;
    if (trapRevealed) this.drawWorldLandmark(graphics, entry, palette.accent);

    if (trapRevealed) {
      const title = this.track(this.scene.add.text(center.x, rect.y + 22, ROOM_NAMES[room.type] ?? room.type, {
        fontFamily: "Georgia, serif",
        fontSize: "17px",
        color: "#eef6ec",
        stroke: "#111817",
        strokeThickness: 4,
      }).setOrigin(0.5).setDepth(3));
      title.setData("roomId", room.id);
      if (room.type === "trap") this.revealedTrapObjects.get(room.id)?.push(title);
    }
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
  ): void {
    const { room, center } = entry;
    const specialObject = SPECIAL_ROOM_OBJECTS[room.type];
    if (specialObject) {
      const image = this.track(this.scene.add.image(center.x, center.y + specialObject.yOffset, specialObject.texture).setDepth(2));
      const scale = Math.min(specialObject.maxWidth / image.width, specialObject.maxHeight / image.height);
      image.setScale(scale);
      image.setData("roomId", room.id);
      image.setData("specialRoomKind", room.type);
      if (room.type === "trap") this.revealedTrapObjects.set(room.id, [image]);
      this.specialRoomObjects.set(room.id, image);
      return;
    }
    if (room.type === "resource") {
      const pickup = this.track(this.scene.add.image(center.x, center.y, "resource-gold-pickup").setDepth(5).setDisplaySize(112, 112));
      pickup.setData("roomId", room.id);
      this.resourcePickups.set(room.id, pickup);
      this.scene.tweens.add({ targets: pickup, y: center.y - 8, duration: 760, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    } else if (room.type === "hidden-monster") {
      graphics.lineStyle(3, 0xc77de0, 0.34).strokeCircle(center.x, center.y, 235).strokeCircle(center.x, center.y, 205);
    } else if (room.type === "boss") {
      graphics.lineStyle(4, 0xff6aa7, 0.46).strokeCircle(center.x, center.y, 270).strokeCircle(center.x, center.y, 235);
    } else if (room.type === "central-waypoint") {
      graphics.fillStyle(accent, 0.15).fillCircle(center.x, center.y, 38);
      graphics.lineStyle(3, accent, 0.72).strokeCircle(center.x, center.y, 38);
    }
  }

  updateResourcePickups(clearedRoomIds: ReadonlySet<string>): void {
    for (const [roomId, pickup] of this.resourcePickups) {
      const available = !clearedRoomIds.has(roomId);
      pickup.setVisible(available).setActive(available);
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

  updateTrapReveals(world: RenderZoneWorld, revealedRooms: ReadonlySet<string>): void {
    for (const roomId of revealedRooms) {
      if (this.revealedTrapObjects.has(roomId)) continue;
      const entry = world.rooms.find((candidate) => candidate.room.id === roomId && candidate.room.type === "trap");
      if (!entry) continue;
      const object = SPECIAL_ROOM_OBJECTS.trap!;
      const image = this.track(this.scene.add.image(entry.center.x, entry.center.y + object.yOffset, object.texture).setDepth(2));
      image.setScale(Math.min(object.maxWidth / image.width, object.maxHeight / image.height));
      image.setData("roomId", roomId).setData("specialRoomKind", "trap");
      const title = this.track(this.scene.add.text(entry.center.x, entry.rect.y + 22, ROOM_NAMES.trap, {
        fontFamily: "Georgia, serif",
        fontSize: "17px",
        color: "#eef6ec",
        stroke: "#111817",
        strokeThickness: 4,
      }).setOrigin(0.5).setDepth(3));
      title.setData("roomId", roomId);
      this.revealedTrapObjects.set(roomId, [image, title]);
    }
  }

  createHero(classId: HeroClassId, x: number, y: number, alpha = 1): Phaser.Physics.Arcade.Sprite {
    const hero = this.scene.physics.add.sprite(x, y, `hero-${classId}`);
    hero.setData("facingDirection", DEFAULT_HERO_FACING);
    hero.setData("heroWasMoving", false);
    hero.setData("heroWalkStartedAt", 0);
    hero.setDepth(20).setAlpha(alpha).setScale(HERO_SPRITE_SCALE);
    (hero.body as Phaser.Physics.Arcade.Body).setCircle(11, 3, 7);
    return hero;
  }

  updateHeroPose(hero: Phaser.Physics.Arcade.Sprite, movementX: number, movementY: number, time: number): void {
    const previous = (hero.getData("facingDirection") as HeroFacingDirection | undefined) ?? DEFAULT_HERO_FACING;
    if (time < Number(hero.getData("attackPoseUntil") ?? 0)) {
      const attackFacing = heroFacingForPose(
        previous,
        movementX,
        movementY,
        hero.getData("attackFacingDirection") as HeroFacingDirection | undefined,
      );
      hero.setData("facingDirection", attackFacing);
      hero.setFrame(heroFrameForPose(attackFacing, false, 0)).setRotation(0);
      return;
    }
    const facing = heroFacingForMovement(previous, movementX, movementY);
    const moving = Math.hypot(movementX, movementY) > 0.001;
    const wasMoving = Boolean(hero.getData("heroWasMoving"));
    if (moving && !wasMoving) hero.setData("heroWalkStartedAt", time);
    const walkStartedAt = Number(hero.getData("heroWalkStartedAt") ?? time);
    const animationElapsedMs = moving ? Math.max(0, time - walkStartedAt) : 0;
    hero.setData("facingDirection", facing);
    hero.setData("heroWasMoving", moving);
    hero.setFrame(heroFrameForPose(facing, moving, animationElapsedMs)).setRotation(0);
    hero.setScale(HERO_SPRITE_SCALE);
  }

  updateHeroStatusEffect(
    heroId: string,
    hero: Phaser.Physics.Arcade.Sprite,
    effect: { key: string; label: string; color: number } | null,
  ): void {
    const current = this.heroStatusEffects.get(heroId);
    if (!effect) {
      if (current) this.destroyHeroStatusEffect(heroId, current);
      return;
    }
    let rendered = current;
    if (!rendered || rendered.key !== effect.key) {
      if (rendered) this.destroyHeroStatusEffect(heroId, rendered);
      const outlines = Array.from({ length: 4 }, () => this.scene.add.sprite(hero.x, hero.y, hero.texture.key, hero.frame.name)
        .setTintFill(effect.color)
        .setAlpha(0.82)
        .setDepth(hero.depth - 0.2));
      const label = this.scene.add.text(hero.x, hero.y - 58, effect.label, {
        fontFamily: '"Noto Serif KR", serif',
        fontSize: "15px",
        fontStyle: "bold",
        color: `#${effect.color.toString(16).padStart(6, "0")}`,
        stroke: "#09070d",
        strokeThickness: 5,
      }).setOrigin(0.5).setDepth(hero.depth + 6);
      rendered = { key: effect.key, outlines, label };
      this.heroStatusEffects.set(heroId, rendered);
      this.scene.tweens.add({
        targets: label,
        alpha: 0,
        delay: 1_350,
        duration: 650,
        ease: "Sine.easeInOut",
      });
    }
    const offsets = [[-3, 0], [3, 0], [0, -3], [0, 3]] as const;
    for (let index = 0; index < rendered.outlines.length; index += 1) {
      const outline = rendered.outlines[index]!;
      const [offsetX, offsetY] = offsets[index]!;
      outline.setTexture(hero.texture.key, hero.frame.name)
        .setPosition(hero.x + offsetX, hero.y + offsetY)
        .setScale(hero.scaleX, hero.scaleY)
        .setRotation(hero.rotation)
        .setFlip(hero.flipX, hero.flipY)
        .setVisible(hero.visible && hero.active);
    }
    rendered.label.setPosition(hero.x, hero.y - 58).setVisible(hero.visible && hero.active && rendered.label.alpha > 0);
  }

  applyDemonHoverMotion(enemy: Phaser.GameObjects.Sprite): void {
    if (enemy.getData("hasHoverMotion")) return;
    enemy.setData("hasHoverMotion", true);

    const baseScaleX = enemy.scaleX;
    const baseScaleY = enemy.scaleY;

    // Wing-flapping breathing & Y-float hover motion
    this.scene.tweens.add({
      targets: enemy,
      scaleY: baseScaleY * 1.05,
      scaleX: baseScaleX * 0.96,
      duration: 850,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });

    // Subtle side sway
    this.scene.tweens.add({
      targets: enemy,
      angle: 2.2,
      duration: 1350,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  private playEnemyEmergence(enemy: Phaser.GameObjects.Sprite, kind: EnemyKind): void {
    const frameWidth = Math.max(1, enemy.frame.realWidth);
    const frameHeight = Math.max(1, enemy.frame.realHeight);
    const duration = kind === "boss" ? 680 : kind === "gate" || kind === "hidden" ? 560 : 420;
    const shadowWidth = kind === "boss" ? 92 : kind === "gate" || kind === "hidden" ? 68 : 38;
    const shadowHeight = kind === "boss" ? 22 : kind === "gate" || kind === "hidden" ? 17 : 10;
    const reveal = { width: 1, height: 1 };
    const shadow = this.scene.add.ellipse(
      enemy.x,
      enemy.y + (kind === "boss" ? 22 : 12),
      shadowWidth,
      shadowHeight,
      0x000000,
      0.88,
    ).setDepth(enemy.depth - 1).setScale(0.22, 0.5);

    enemy
      .setData("isEmerging", true)
      .setData("hasHoverMotion", false)
      .setAlpha(0.12)
      .setTint(0x050505)
      .setCrop(
        kind === "gate" ? (frameWidth - 1) / 2 : 0,
        kind === "gate" ? (frameHeight - 1) / 2 : frameHeight - 1,
        kind === "gate" ? 1 : frameWidth,
        1,
      );

    if (kind === "gate") {
      const innerPulse = this.scene.add.circle(enemy.x, enemy.y, 8, 0x8f5dff, 0.28)
        .setStrokeStyle(3, 0xd8c3ff, 0.84)
        .setDepth(enemy.depth - 1);
      const outerPulse = this.scene.add.circle(enemy.x, enemy.y, 10, 0x4d287c, 0.12)
        .setStrokeStyle(2, 0x9e72e8, 0.58)
        .setDepth(enemy.depth - 1);
      this.scene.tweens.add({
        targets: innerPulse,
        radius: 72,
        alpha: 0,
        duration: duration + 80,
        ease: "Cubic.easeOut",
        onComplete: () => innerPulse.destroy(),
      });
      this.scene.tweens.add({
        targets: outerPulse,
        radius: 112,
        alpha: 0,
        duration: duration + 180,
        ease: "Quart.easeOut",
        onComplete: () => outerPulse.destroy(),
      });
    }

    this.scene.tweens.add({
      targets: shadow,
      scaleX: 1.22,
      scaleY: 1,
      alpha: 0,
      duration: duration + 110,
      ease: "Cubic.easeOut",
      onComplete: () => shadow.destroy(),
    });
    this.scene.tweens.add({
      targets: enemy,
      alpha: 1,
      duration: Math.min(260, duration),
      ease: "Quad.easeOut",
    });
    this.scene.tweens.add({
      targets: reveal,
      width: frameWidth,
      height: frameHeight,
      duration,
      ease: "Cubic.easeOut",
      onUpdate: () => {
        if (!enemy.active) return;
        const revealedHeight = Math.max(1, Math.min(frameHeight, reveal.height));
        if (kind === "gate") {
          const revealedWidth = Math.max(1, Math.min(frameWidth, reveal.width));
          enemy.setCrop(
            (frameWidth - revealedWidth) / 2,
            (frameHeight - revealedHeight) / 2,
            revealedWidth,
            revealedHeight,
          );
        } else {
          enemy.setCrop(0, frameHeight - revealedHeight, frameWidth, revealedHeight);
        }
      },
      onComplete: () => {
        if (!enemy.active) return;
        enemy.setCrop().clearTint().setAlpha(1).setOrigin(0.5, 0.5).setData("isEmerging", false);
        if (kind === "hidden") this.applyDemonHoverMotion(enemy);
      },
    });
  }

  applyBullChargeMotion(enemy: Phaser.GameObjects.Sprite): void {
    if (enemy.getData("hasBullMotion")) return;
    enemy.setData("hasBullMotion", true);

    // Fast aggressive galloping motion
    this.scene.tweens.add({
      targets: enemy,
      scaleY: enemy.scaleY * 1.07,
      scaleX: enemy.scaleX * 0.94,
      duration: 320,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  applyDragonHoverMotion(enemy: Phaser.GameObjects.Sprite): void {
    if (enemy.getData("hasDragonMotion")) return;
    enemy.setData("hasDragonMotion", true);

    // Grand wing-flapping flight motion
    this.scene.tweens.add({
      targets: enemy,
      scaleY: enemy.scaleY * 1.08,
      displayOriginY: enemy.displayOriginY + 14,
      duration: 800,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
    this.scene.tweens.add({
      targets: enemy,
      angle: 3.5,
      duration: 1100,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  private resolveMidbossTextureKey(): string {
    const zone = (this.scene as unknown as { currentZone?: number }).currentZone ?? 1;
    if (zone === 1 && this.scene.textures.exists("enemy-tree-midboss-asset")) {
      return "enemy-tree-midboss-asset";
    }
    if (this.scene.textures.exists("enemy-demon-midboss-asset")) {
      return "enemy-demon-midboss-asset";
    }
    return "enemy-demon-midboss-0";
  }

  createEnemy(kind: EnemyKind, x: number, y: number): Phaser.Physics.Arcade.Sprite {
    const look = ENEMY_LOOK[kind];
    const midbossKey = this.resolveMidbossTextureKey();
    const hasMidbossAsset = kind === "hidden" && (this.scene.textures.exists("enemy-tree-midboss-asset") || this.scene.textures.exists("enemy-demon-midboss-asset"));
    const hasGateAsset = kind === "gate" && this.scene.textures.exists("enemy-gate-asset");
    const hasBossBullAsset = kind === "boss" && this.scene.textures.exists("enemy-boss-bull-asset");

    const textureKey = kind === "gate"
      ? (hasGateAsset ? "enemy-gate-asset" : "gate")
      : kind === "hidden"
        ? midbossKey
        : kind === "boss"
          ? (hasBossBullAsset ? "enemy-boss-bull-asset" : "boss")
          : "enemy-skeleton-0";

    const enemy = this.scene.physics.add.sprite(x, y, textureKey).setDepth(look.depth).setScale(UNIT_RENDER_SCALE);
    if (hasMidbossAsset) enemy.setDisplaySize(MIDBOSS_DISPLAY_SIZE, MIDBOSS_DISPLAY_SIZE);
    if (hasGateAsset) enemy.setDisplaySize(GATE_DISPLAY_WIDTH, GATE_DISPLAY_HEIGHT);
    if (kind === "boss") {
      enemy.setDisplaySize(BOSS_DISPLAY_SIZE, BOSS_DISPLAY_SIZE);
      if (hasBossBullAsset) this.applyBullChargeMotion(enemy);
    }
    (enemy.body as Phaser.Physics.Arcade.Body).setCircle(look.radius);
    if (kind === "gate" || kind === "boss") enemy.setImmovable(true);
    this.playEnemyEmergence(enemy, kind);
    return enemy;
  }

  /** Network enemies are server-authoritative and do not need an Arcade body. */
  acquireNetworkEnemy(kind: EnemyKind, x: number, y: number): Phaser.GameObjects.Sprite {
    const pool = this.networkEnemyPool.get(kind);
    const enemy = pool?.pop() ?? this.scene.add.sprite(x, y, ENEMY_LOOK[kind].texture);
    const midbossKey = this.resolveMidbossTextureKey();
    const hasMidbossAsset = kind === "hidden" && (this.scene.textures.exists("enemy-tree-midboss-asset") || this.scene.textures.exists("enemy-demon-midboss-asset"));
    const hasGateAsset = kind === "gate" && this.scene.textures.exists("enemy-gate-asset");
    const hasBossBullAsset = kind === "boss" && this.scene.textures.exists("enemy-boss-bull-asset");

    const textureKey = kind === "gate"
      ? (hasGateAsset ? "enemy-gate-asset" : "gate")
      : kind === "hidden"
        ? midbossKey
        : kind === "boss"
          ? (hasBossBullAsset ? "enemy-boss-bull-asset" : "boss")
          : "enemy-skeleton-0";

    enemy
      .setTexture(textureKey)
      .setPosition(x, y)
      .setDepth(ENEMY_LOOK[kind].depth)
      .setScale(UNIT_RENDER_SCALE)
      .setAlpha(1)
      .setVisible(true)
      .setActive(true);
    if (hasMidbossAsset) enemy.setDisplaySize(MIDBOSS_DISPLAY_SIZE, MIDBOSS_DISPLAY_SIZE);
    if (hasGateAsset) enemy.setDisplaySize(GATE_DISPLAY_WIDTH, GATE_DISPLAY_HEIGHT);
    if (kind === "boss") {
      enemy.setDisplaySize(BOSS_DISPLAY_SIZE, BOSS_DISPLAY_SIZE);
      if (hasBossBullAsset) this.applyBullChargeMotion(enemy);
    }
    this.playEnemyEmergence(enemy, kind);
    return enemy;
  }

  releaseNetworkEnemy(kind: EnemyKind, enemy: Phaser.GameObjects.Sprite): void {
    this.scene.tweens.killTweensOf(enemy);
    enemy.setData("hasHoverMotion", false);
    enemy.setData("isEmerging", false);
    enemy.setData("hasBullMotion", false);
    enemy.setData("hasDragonMotion", false);
    enemy.setAngle(0);
    enemy.setCrop().clearTint().setScale(1).setAlpha(1).setVisible(false).setActive(false).setPosition(-10_000, -10_000);
    const pool = this.networkEnemyPool.get(kind) ?? [];
    if (pool.length < NETWORK_ENEMY_POOL_LIMIT[kind]) {
      pool.push(enemy);
      this.networkEnemyPool.set(kind, pool);
    } else {
      enemy.destroy();
    }
  }

  updateEnemyPose(sprite: Phaser.Physics.Arcade.Sprite, kind: string, targetX?: number, targetY?: number): void {
    if (!sprite.active || !sprite.body) return;
    const body = sprite.body as Phaser.Physics.Arcade.Body;
    const vx = body.velocity.x;
    const vy = body.velocity.y;
    const speedSq = vx * vx + vy * vy;

    let angle = 90;
    if (typeof targetX === "number" && typeof targetY === "number") {
      angle = Phaser.Math.RadToDeg(Math.atan2(targetY - sprite.y, targetX - sprite.x));
    } else if (speedSq > 4) {
      angle = Phaser.Math.RadToDeg(Math.atan2(vy, vx));
    }

    const normalized = (angle + 360) % 360;
    const snapAngle = (Math.round(normalized / 45) * 45) % 360;
    if (kind === "hidden") {
      const midbossKey = this.resolveMidbossTextureKey();
      if (midbossKey !== "enemy-demon-midboss-0") {
        sprite.setTexture(midbossKey).setDisplaySize(MIDBOSS_DISPLAY_SIZE, MIDBOSS_DISPLAY_SIZE);
      } else {
        sprite.setTexture(`enemy-demon-midboss-${snapAngle}`);
      }
    } else if (kind === "gate") {
      if (this.scene.textures.exists("enemy-gate-asset")) {
        sprite.setTexture("enemy-gate-asset").setDisplaySize(GATE_DISPLAY_WIDTH, GATE_DISPLAY_HEIGHT);
      }
    } else if (kind === "boss") {
      const isDragon = sprite.getData("bossPhase") === "dragon";
      if (isDragon && this.scene.textures.exists("enemy-boss-dragon-asset")) {
        sprite.setTexture("enemy-boss-dragon-asset").setDisplaySize(BOSS_DISPLAY_SIZE, BOSS_DISPLAY_SIZE);
        this.applyDragonHoverMotion(sprite);
      } else if (this.scene.textures.exists("enemy-boss-bull-asset")) {
        sprite.setTexture("enemy-boss-bull-asset").setDisplaySize(BOSS_DISPLAY_SIZE, BOSS_DISPLAY_SIZE);
        this.applyBullChargeMotion(sprite);
      } else {
        sprite.setDisplaySize(BOSS_DISPLAY_SIZE, BOSS_DISPLAY_SIZE);
      }
    } else if (kind === "static" || kind === "invader") {
      sprite.setTexture(`enemy-skeleton-${snapAngle}`);
    } else {
      sprite.setAngle(angle);
    }
  }

  createDrop(x: number, y: number, rarity: "normal" | "rare" | "epic" | "legendary" | "mythic"): Phaser.GameObjects.Container {
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

  showClassAttack(
    classId: HeroClassId,
    attacker: Phaser.Physics.Arcade.Sprite,
    targetX: number,
    targetY: number,
    aimAngle?: number,
    critical = false,
    level = 1,
  ): void {
    this.playCombatSound(classId, "basic", attacker.x, attacker.y);
    const color = classColor(classId);
    const effectColor = critical ? CRITICAL_ATTACK_COLORS[classId] : color;
    const targetAngle = Phaser.Math.Angle.Between(attacker.x, attacker.y, targetX, targetY);
    const aim = Number.isFinite(aimAngle) ? Phaser.Math.Angle.Wrap(aimAngle as number) : targetAngle;
    const angle = classId === "swordsman" ? targetAngle : aim;
    const travelDistance = Phaser.Math.Distance.Between(attacker.x, attacker.y, targetX, targetY);
    const effectTargetX = classId === "swordsman" ? targetX : attacker.x + Math.cos(angle) * travelDistance;
    const effectTargetY = classId === "swordsman" ? targetY : attacker.y + Math.sin(angle) * travelDistance;
    const attackFacing = heroFacingForAim(angle);
    attacker.setData("facingDirection", attackFacing);
    attacker.setData("attackFacingDirection", attackFacing);
    attacker.setFrame(heroFrameForPose(attackFacing, false, 0));
    attacker.setData("attackPoseUntil", this.scene.time.now + 130);
    this.scene.tweens.add({ targets: attacker, scaleX: attacker.scaleX * 1.16, scaleY: attacker.scaleY * 0.9, duration: 55, yoyo: true });
    if (classId === "swordsman") {
      const sprite = basicAttackSpriteForLevel(classId, level);
      const slashDirection = swordsmanSlashAnimationDirectionForAim(angle);
      const direction = { x: Math.cos(angle), y: Math.sin(angle) };
      const slash = this.scene.add.sprite(
        attacker.x + direction.x * 34,
        attacker.y + direction.y * 34,
        sprite.textureKey,
      ).setDisplaySize(critical ? 225 : 170, critical ? 225 : 170)
        .setTint(critical ? effectColor : 0xffffff)
        .setBlendMode(critical ? Phaser.BlendModes.ADD : Phaser.BlendModes.NORMAL)
        .setDepth(31)
        .play(`${sprite.animationKey}-${slashDirection}`);
      this.scene.tweens.add({
        targets: slash,
        x: effectTargetX,
        y: effectTargetY,
        duration: Phaser.Math.Clamp(travelDistance * 0.75, 110, 220),
        ease: "Cubic.easeOut",
        onComplete: () => {
          this.showImpact(effectTargetX, effectTargetY, critical ? 54 : 34, effectColor);
          if (critical) this.showCriticalImpact(effectTargetX, effectTargetY, effectColor);
          slash.destroy();
        },
      });
    } else if (classId === "archer") {
      const sprite = basicAttackSpriteForLevel(classId, level);
      const arrow = this.scene.add.sprite(
        attacker.x + Math.cos(angle) * 18,
        attacker.y + Math.sin(angle) * 18,
        sprite.textureKey,
      ).setDisplaySize(critical ? 126 : 96, critical ? 47 : 36)
        .setRotation(angle)
        .setTint(critical ? effectColor : 0xffffff)
        .setBlendMode(critical ? Phaser.BlendModes.ADD : Phaser.BlendModes.NORMAL)
        .setDepth(31)
        .play(sprite.animationKey);
      this.scene.tweens.add({
        targets: arrow,
        x: effectTargetX,
        y: effectTargetY,
        duration: 135,
        ease: "Quad.easeIn",
        onComplete: () => {
          this.showImpact(effectTargetX, effectTargetY, critical ? 38 : 25, effectColor);
          if (critical) this.showCriticalImpact(effectTargetX, effectTargetY, effectColor);
          arrow.destroy();
        },
      });
    } else {
      const sprite = basicAttackSpriteForLevel(classId, level);
      const orb = this.scene.add.sprite(attacker.x, attacker.y, sprite.textureKey)
        .setDisplaySize(critical ? 58 : 42, critical ? 58 : 42)
        .setTint(critical ? effectColor : 0xffffff)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(31)
        .play(sprite.animationKey);
      const orbEndScale = orb.scaleX * (critical ? 1.38 : 1.25);
      this.scene.tweens.add({
        targets: orb,
        x: effectTargetX,
        y: effectTargetY,
        scale: orbEndScale,
        rotation: angle + Math.PI * 0.8,
        duration: 165,
        ease: "Sine.easeIn",
        onComplete: () => {
          this.showImpact(effectTargetX, effectTargetY, critical ? 68 : 48, effectColor);
          if (critical) this.showCriticalImpact(effectTargetX, effectTargetY, effectColor);
          orb.destroy();
        },
      });
      const rune = this.scene.add.circle(attacker.x, attacker.y, 26, color, 0.06).setStrokeStyle(3, color, 0.8).setDepth(30);
      this.scene.tweens.add({ targets: rune, radius: 52, rotation: Math.PI, alpha: 0, duration: 260, onComplete: () => rune.destroy() });
    }
  }

  showAutoSkill(classId: HeroClassId, skillId: "q" | "e", attacker: Phaser.GameObjects.Sprite, targetX: number, targetY: number, radius: number): void {
    this.playCombatSound(classId, skillId, attacker.x, attacker.y);
    const color = classColor(classId);
    const angle = Phaser.Math.Angle.Between(attacker.x, attacker.y, targetX, targetY);
    attacker.setData("attackPoseUntil", this.scene.time.now + 180);
    this.scene.tweens.add({ targets: attacker, scaleX: attacker.scaleX * 1.12, scaleY: attacker.scaleY * 0.88, duration: 80, yoyo: true });
    if (classId === "swordsman") {
      const arc = this.scene.add.arc(attacker.x, attacker.y, skillId === "q" ? radius : 48,
        Phaser.Math.RadToDeg(angle) - (skillId === "q" ? 120 : 35),
        Phaser.Math.RadToDeg(angle) + (skillId === "q" ? 120 : 35), false)
        .setStrokeStyle(skillId === "q" ? 14 : 9, 0xfff4b0, 0.92).setDepth(32);
      this.scene.tweens.add({ targets: arc, scale: 1.2, alpha: 0, duration: 260, onComplete: () => arc.destroy() });
      if (skillId === "e") this.showAttack(attacker.x, attacker.y, targetX, targetY, color);
    } else if (classId === "archer") {
      if (skillId === "q") {
        for (const offset of [-0.08, 0, 0.08]) {
          const arrow = this.scene.add.rectangle(attacker.x, attacker.y, 34, 5, 0xd9ffe2, 1).setRotation(angle + offset).setDepth(32);
          this.scene.tweens.add({ targets: arrow, x: targetX, y: targetY, duration: 180, ease: "Quad.easeIn", onComplete: () => arrow.destroy() });
        }
      } else {
        const rain = this.scene.add.circle(targetX, targetY, radius, color, 0.1).setStrokeStyle(4, color, 0.85).setDepth(30);
        this.scene.tweens.add({ targets: rain, scale: 1.12, alpha: 0, duration: 420, onComplete: () => rain.destroy() });
        for (let index = 0; index < 5; index += 1) {
          const x = targetX + Math.cos(index * 1.7) * radius * 0.65;
          const y = targetY + Math.sin(index * 1.7) * radius * 0.65;
          const arrow = this.scene.add.rectangle(x, y - 70, 4, 24, 0xd9ffe2, 0.88).setDepth(32);
          this.scene.tweens.add({ targets: arrow, y: y, duration: 180 + index * 24, onComplete: () => { this.showImpact(x, y, 20, color); arrow.destroy(); } });
        }
      }
    } else if (skillId === "q") {
      const orb = this.scene.add.circle(attacker.x, attacker.y, 16, 0xe6c8ff, 0.95).setStrokeStyle(4, 0xffffff, 0.9).setDepth(32);
      this.scene.tweens.add({ targets: orb, x: targetX, y: targetY, scale: 1.35, duration: 220, ease: "Sine.easeIn", onComplete: () => { this.showImpact(targetX, targetY, 42, color); orb.destroy(); } });
    } else {
      const rune = this.scene.add.circle(targetX, targetY, radius * 0.45, color, 0.1).setStrokeStyle(4, 0xdcc4ff, 0.9).setDepth(30);
      this.scene.tweens.add({ targets: rune, scale: 2.1, angle: 180, alpha: 0, duration: 460, onComplete: () => rune.destroy() });
      this.showImpact(targetX, targetY, radius, color);
    }
  }

  private playCombatSound(classId: HeroClassId, action: CombatSoundAction, x: number, y: number): void {
    const camera = this.scene.cameras.main;
    const distance = Phaser.Math.Distance.Between(camera.midPoint.x, camera.midPoint.y, x, y);
    const audibleRadius = Math.max(camera.width, camera.height) * 0.85;
    if (distance > audibleRadius) return;
    const baseVolume = action === "basic" ? 0.34 : 0.5;
    const distanceScale = Phaser.Math.Clamp(1 - distance / audibleRadius, 0.22, 1);
    this.scene.sound.play(combatSoundKey(classId, action), {
      volume: baseVolume * distanceScale,
      rate: Phaser.Math.FloatBetween(0.96, 1.04),
    });
  }

  /**
   * Dodge feedback: hero afterimages along the dash path plus a start burst.
   * Both are anchored to the resolved start/landing points, so the effect can
   * never spill outside the walkable area or the camera view.
   */
  showDodge(sprite: Phaser.GameObjects.Sprite, targetX: number, targetY: number, originX?: number, originY?: number): void {
    const startX = originX ?? sprite.x;
    const startY = originY ?? sprite.y;
    const dx = targetX - startX;
    const dy = targetY - startY;
    const distance = Math.hypot(dx, dy);
    if (distance > 8) {
      const ghostCount = 4;
      for (let index = 1; index <= ghostCount; index += 1) {
        const progress = index / (ghostCount + 1);
        const ghost = this.scene.add.image(
          startX + dx * progress,
          startY + dy * progress,
          sprite.texture.key,
          sprite.frame.name,
        )
          .setDepth(26)
          .setAlpha(0.32)
          .setScale(sprite.scaleX);
        this.scene.tweens.add({
          targets: ghost,
          alpha: 0,
          scale: ghost.scaleX * 0.88,
          duration: 260,
          delay: index * 26,
          onComplete: () => ghost.destroy(),
        });
      }
    }
    const burst = this.scene.add.circle(startX, startY, 12, 0xbfffea, 0.3)
      .setStrokeStyle(3, 0xffffff, 0.9)
      .setDepth(27);
    this.scene.tweens.add({
      targets: burst,
      radius: 44,
      alpha: 0,
      duration: 280,
      onComplete: () => burst.destroy(),
    });
  }

  showImpact(x: number, y: number, radius: number, color: number): void {
    const impact = this.scene.add.circle(x, y, 7, color, 0.28).setStrokeStyle(2, color, 0.9).setDepth(32);
    this.scene.tweens.add({ targets: impact, radius, alpha: 0, duration: 230, onComplete: () => impact.destroy() });
  }

  private showCriticalImpact(x: number, y: number, color: number): void {
    const flash = this.scene.add.star(x, y, 8, 8, 25, color, 0.92)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(34);
    const ring = this.scene.add.circle(x, y, 13, color, 0.2)
      .setStrokeStyle(4, color, 1)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(33);
    this.scene.tweens.add({
      targets: flash,
      scale: 2.2,
      rotation: Math.PI / 5,
      alpha: 0,
      duration: 260,
      ease: "Cubic.easeOut",
      onComplete: () => flash.destroy(),
    });
    this.scene.tweens.add({
      targets: ring,
      radius: 62,
      lineWidth: 1,
      alpha: 0,
      duration: 310,
      ease: "Cubic.easeOut",
      onComplete: () => ring.destroy(),
    });
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

  showEnemyMeleeAttack(enemy: Phaser.GameObjects.Sprite, targetX: number, targetY: number): void {
    const angle = Phaser.Math.Angle.Between(enemy.x, enemy.y, targetX, targetY);
    const slash = this.scene.add.arc(enemy.x, enemy.y, 34, Phaser.Math.RadToDeg(angle) - 65, Phaser.Math.RadToDeg(angle) + 65, false)
      .setStrokeStyle(7, 0xff7a86, 0.9).setDepth(30);
    this.scene.tweens.add({ targets: enemy, scaleX: 1.22, scaleY: 0.82, duration: 90, yoyo: true });
    this.scene.tweens.add({ targets: slash, scale: 1.35, alpha: 0, duration: 210, onComplete: () => slash.destroy() });
    this.showImpact(targetX, targetY, 24, 0xff596c);
  }

  destroy(): void {
    for (const [heroId, effect] of this.heroStatusEffects) this.destroyHeroStatusEffect(heroId, effect);
    this.clearRoom();
    for (const pool of this.networkEnemyPool.values()) {
      for (const enemy of pool) enemy.destroy();
    }
    this.networkEnemyPool.clear();
    this.crosshair?.destroy();
    this.scene.game.canvas.style.cursor = "";
  }

  private destroyHeroStatusEffect(
    heroId: string,
    effect: { outlines: Phaser.GameObjects.Sprite[]; label: Phaser.GameObjects.Text },
  ): void {
    for (const outline of effect.outlines) outline.destroy();
    this.scene.tweens.killTweensOf(effect.label);
    effect.label.destroy();
    this.heroStatusEffects.delete(heroId);
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
    this.resourcePickups.clear();
    this.revealedTrapObjects.clear();
    for (const pattern of this.enemyPatternObjects.values()) pattern.graphics.destroy();
    this.enemyPatternObjects.clear();
    for (const mask of this.roomMasks) mask.destroy();
    this.roomMasks = [];
    for (const object of this.waypointObjects) object.destroy();
    this.waypointObjects = [];
    for (const object of this.roomObjects) {
      this.scene.tweens.killTweensOf(object);
      object.destroy();
    }
    this.roomObjects = [];
    this.specialRoomObjects.clear();
    this.transitioningShrineIds.clear();
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
