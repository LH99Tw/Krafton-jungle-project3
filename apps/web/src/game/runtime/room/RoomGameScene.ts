import * as Phaser from "phaser";
import {
  OFFICIAL_MAP_MANIFEST,
  explorationPercent as calculateExplorationPercent,
  type CoreWorldDefinition,
  type ZoneId,
} from "@five-days/game-core";
import { CLASS_DEFINITIONS } from "../../content/classes";
import type {
  GameSnapshot,
  GameStartOptions,
  NetworkWorldSnapshot,
  PartyMemberSnapshot,
  Phase,
  TeamStats,
} from "../../domain/types";
import { NIGHT_PLAYER_VISION_RADIUS, PLAYER_VISION_RADIUS, transformFlags, type CombatActionEvent, type InputFrame, type WorldFrame } from "@five-days/protocol";
import { resolveSharedPartyProgress } from "../../domain/sharedPartyProgress";
import { editorThemeZone, type EditorConnection } from "../../domain/mapEditor";
import { buildEditorCoreWorld, editorCoreRoomId } from "@/src/features/map-editor/editorCoreWorld";
import { localCoreSession } from "@/src/features/map-editor/LocalCoreSession";
import { HERO_SPRITE_FRAME_SIZE, HERO_SPRITE_PATHS, HERO_TOTAL_FRAME_COUNT } from "../../client/render/heroSprites";
import { BASIC_ATTACK_ALL_SPRITES } from "../../client/render/attackEffectSprites";
import { SKELETON_FRAME_COUNT, SKELETON_FRAME_SIZE, SKELETON_SPRITE_PATH } from "../../client/render/enemySprites";
import { COMBAT_SOUND_PATHS } from "../../client/audio/combatSounds";
import { colyseusTransport } from "../../transport/ColyseusTransport";
import { areAuthoredBossGatesCleared, predictPlayerTransform, RealtimeTransformBuffer, shouldRenderPartyMember } from "../../netcode/RealtimeBuffer";
import { aimAngleBetween } from "../../netcode/aim";
import { gameBridge, type GameCommand } from "../GameBridge";
import {
  buildEditorRenderWorld,
  clampToWorld,
  type RenderableRoom,
  type RenderZoneWorld,
} from "./layout";
import { PlayerVisionFog } from "./PlayerVisionFog";
import { RoomRenderer, type ProgressionBarrier } from "./RoomRenderer";
import { alignEnemyAttackToRenderTimeline, type RenderPoint } from "./networkCombatVisuals";
import type { VisionRevealSource } from "./vision";

type RenderedEnemyKind = "static" | "hidden" | "gate" | "invader" | "boss";
const VISION_RADIUS_CHANGE_PER_SECOND = 220;
const OFFICIAL_PREDICTION_ROOMS = OFFICIAL_MAP_MANIFEST.world.rooms.map((room) => ({
  id: room.id,
  rect: room.rect,
  zone: room.zone,
}));
const OFFICIAL_LOCKED_WALKABLE = [
  ...OFFICIAL_MAP_MANIFEST.world.rooms
    .filter((room) => room.id !== OFFICIAL_MAP_MANIFEST.world.bossRoomId)
    .map((room) => room.rect),
  ...OFFICIAL_MAP_MANIFEST.world.connections
    .filter((connection) => (
      connection.from !== OFFICIAL_MAP_MANIFEST.world.bossRoomId
      && connection.to !== OFFICIAL_MAP_MANIFEST.world.bossRoomId
    ))
    .flatMap((connection) => connection.floorRects),
];
const OFFICIAL_OPEN_PREDICTION_WORLD = {
  walkable: OFFICIAL_MAP_MANIFEST.world.walkable,
  rooms: OFFICIAL_PREDICTION_ROOMS,
};
const OFFICIAL_LOCKED_PREDICTION_WORLD = {
  walkable: OFFICIAL_LOCKED_WALKABLE,
  rooms: OFFICIAL_PREDICTION_ROOMS,
};

const SHRINE_STATUS_VISUALS: Record<string, { label: string; color: number }> = {
  berserker: { label: "광전사의 성소", color: 0xff5b3f },
  assassin: { label: "암살자의 성소", color: 0xff3ce7 },
  giant: { label: "거인의 성소", color: 0xffc85c },
  wind: { label: "바람의 성소", color: 0x58e5ff },
  infinity: { label: "무한의 성소", color: 0x9c62ff },
  doom: { label: "파멸의 성소", color: 0xff244f },
};
const TRAP_STATUS_VISUALS: Record<string, { label: string; color: number }> = {
  "move-speed": { label: "이동속도 감소", color: 0x7193b8 },
  attack: { label: "공격력 감소", color: 0xb63232 },
  "attack-speed": { label: "공격속도 감소", color: 0xb58b3f },
  "skills-disabled": { label: "스킬 봉인", color: 0x725483 },
  "basic-disabled": { label: "기본공격 봉인", color: 0x777777 },
  "max-hp": { label: "최대 체력 감소", color: 0xd22e57 },
  "healing-disabled": { label: "회복 불가", color: 0x6d8f4e },
  vision: { label: "시야 감소", color: 0x4d528f },
  tether: { label: "결속의 저주", color: 0x64d5ff },
};

type AuthoredMapRoom = {
  id: string;
  zone: ZoneId;
  x: number;
  y: number;
  width?: number;
  height?: number;
  type: RenderableRoom["type"];
  connections: readonly string[];
  depthScore: number;
};

const PHASE_LABELS: Record<Phase, string> = {
  day: "낮 · 방 탐색",
  night: "밤 · 기지 공세",
  standby: "정산 · 재정비",
  boss: "마왕전",
  ended: "원정 종료",
};

const BASE_MAX_HP = 900;
const NETWORK_ENEMY_SPAWN_BUDGET_MS = 3;
const NETWORK_ENEMY_SPAWN_LIMIT = 12;

type PredictionWorld = {
  walkable: readonly { x: number; y: number; width: number; height: number }[];
  rooms: readonly { id: string; rect: { x: number; y: number; width: number; height: number }; zone: number }[];
  maxAccessibleZone: number;
  blockedRects: readonly { x: number; y: number; width: number; height: number }[];
};

export class RoomGameScene extends Phaser.Scene {
  private readonly runSeed: string;
  private readonly editorRooms: readonly AuthoredMapRoom[];
  private readonly authoredConnections: readonly EditorConnection[];
  private readonly progressionWorld: CoreWorldDefinition | null;
  private roomRenderer!: RoomRenderer;
  private player!: Phaser.Physics.Arcade.Sprite;
  private visionFog!: PlayerVisionFog;
  private deathOverlay!: Phaser.GameObjects.Rectangle;
  private deathOverlayText!: Phaser.GameObjects.Text;
  private deathPresentationActive = false;
  private keys!: Record<"W" | "A" | "S" | "D" | "Q" | "E" | "SPACE" | "B", Phaser.Input.Keyboard.Key>;
  private commandDisconnect?: () => void;
  private networkDisconnect?: () => void;
  private worldFrameDisconnect?: () => void;
  private localInputDisconnect?: () => void;
  private messageDisconnect?: () => void;
  private combatActionDisconnect?: () => void;
  private readonly pendingCombatActions: Array<{ action: CombatActionEvent; expiresAt: number }> = [];
  private readonly renderedCombatActionIds = new Set<number>();
  private readonly renderedCombatActionOrder: number[] = [];
  private localMovementX = 0;
  private localMovementY = 0;
  private lastWalkablePlayerPosition: { x: number; y: number } | null = null;
  private readonly remotePlayers = new Map<string, Phaser.Physics.Arcade.Sprite>();
  private readonly networkEnemies = new Map<string, Phaser.GameObjects.Sprite>();
  private readonly networkEnemyKinds = new Map<string, RenderedEnemyKind>();
  private readonly pendingNetworkEnemyIds: string[] = [];
  private readonly pendingNetworkEnemySet = new Set<string>();
  private readonly networkEnemyHp = new Map<string, number>();
  private networkEnemyHpLayer!: Phaser.GameObjects.Graphics;
  private waypointHoldBar!: Phaser.GameObjects.Graphics;
  private lastNetworkHpDrawAt = 0;
  private readonly networkEnemyAttackSequence = new Map<string, number>();
  private readonly networkPlayerAttackSequence = new Map<string, number>();
  private readonly networkPlayerSkillSequence = new Map<string, number>();
  private readonly networkDrops = new Map<string, Phaser.GameObjects.Container>();
  private readonly networkDropRequests = new Map<string, number>();
  private currentZone: ZoneId = 1;
  private currentRoomId: string;
  private zoneWorld!: RenderZoneWorld;
  private authoredRenderWorld?: RenderZoneWorld;
  private localPhase: Phase = "day";
  private currentVisionRadius = PLAYER_VISION_RADIUS;
  private snapshotAccumulator = 0;
  private message = "연결된 문을 따라 첫 구역을 탐색하세요.";
  private latestNetwork: NetworkWorldSnapshot | null = null;
  private readonly transformBuffer = new RealtimeTransformBuffer();
  private localPrediction: { x: number; y: number; roomId: string } | null = null;
  private localCorrection: { x: number; y: number; startedAt: number } | null = null;
  private renderedNetworkRoomKey = "";
  private renderedNetworkDraftId: string | null | undefined;
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
    super({ key: "room-game" });
    this.runSeed = `v02:${options.userId ?? "local"}:${options.heroClass}:${options.difficulty}`;
    const authoredMap = options.editorMap ?? OFFICIAL_MAP_MANIFEST.map;
    this.progressionWorld = options.editorMap
      ? buildEditorCoreWorld(options.editorMap)
      : OFFICIAL_MAP_MANIFEST.world;
    this.authoredConnections = authoredMap.connections.map((connection) => ({
      ...connection,
      fromPort: connection.fromPort ? { ...connection.fromPort } : undefined,
      toPort: connection.toPort ? { ...connection.toPort } : undefined,
    }));
    this.editorRooms = authoredMap.rooms.map((room): AuthoredMapRoom => ({
      id: editorCoreRoomId(room.id),
      zone: editorThemeZone(room.asset),
      x: room.x,
      y: room.y,
      width: room.width,
      height: room.height,
      type: room.type,
      connections: authoredMap.connections
        .filter((connection) => connection.from === room.id || connection.to === room.id)
        .map((connection) => {
          const connectedId = connection.from === room.id ? connection.to : connection.from;
          return editorCoreRoomId(connectedId);
        }),
      depthScore: room.x + room.y,
    }));
    this.currentRoomId = this.editorRooms.find((room) => room.type === "start")?.id
      ?? OFFICIAL_MAP_MANIFEST.world.baseRoomId;
  }

  preload(): void {
    gameBridge.emit("loading", { progress: 0.04, label: "그래픽 자원 내려받는 중" });
    this.load.on(Phaser.Loader.Events.PROGRESS, (progress: number) => {
      gameBridge.emit("loading", { progress: 0.05 + progress * 0.72, label: "그래픽 자원 내려받는 중" });
    });
    this.load.once(Phaser.Loader.Events.COMPLETE, () => {
      gameBridge.emit("loading", { progress: 0.78, label: "텍스처 준비 중" });
    });
    for (const [classId, path] of Object.entries(HERO_SPRITE_PATHS)) {
      this.load.spritesheet(`hero-${classId}`, path, {
        frameWidth: HERO_SPRITE_FRAME_SIZE,
        frameHeight: HERO_SPRITE_FRAME_SIZE,
        endFrame: HERO_TOTAL_FRAME_COUNT - 1,
      });
    }
    for (const zone of [1, 2, 3] as const) {
      this.load.image(`zone-${zone}-vegetation`, `/Asset/zone-${zone}-vegetation.png`);
      this.load.image(`zone-${zone}-room-corridor`, `/Asset/zone-${zone}-room-corridor-atlas.png`);
    }
    this.load.image("zone-1-blocked", "/Asset/zone-1-blocked-forest.png");
    this.load.image("zone-2-blocked", "/Asset/zone-2-blocked-marsh.png");
    this.load.image("zone-3-blocked", "/Asset/zone-3-blocked-wastes.png");
    this.load.image("enemy-demon-midboss-asset", "/images/demon_midboss.png");
    this.load.image("enemy-tree-midboss-asset", "/images/tree_midboss.png");
    this.load.spritesheet("enemy-skeleton-unarmed", SKELETON_SPRITE_PATH, {
      frameWidth: SKELETON_FRAME_SIZE,
      frameHeight: SKELETON_FRAME_SIZE,
      endFrame: SKELETON_FRAME_COUNT * 8 - 1,
    });
    for (const sprite of BASIC_ATTACK_ALL_SPRITES) {
      this.load.spritesheet(sprite.textureKey, sprite.path, {
        frameWidth: sprite.frameWidth,
        frameHeight: sprite.frameHeight,
        endFrame: sprite.frameCount * (sprite.rows ?? 1) - 1,
      });
    }
    for (const [key, path] of Object.entries(COMBAT_SOUND_PATHS)) this.load.audio(key, path);
    this.load.image("enemy-gate-asset", "/images/rift_gate.png");
    this.load.image("enemy-boss-bull-asset", "/images/boss_bull.png");
    this.load.image("enemy-boss-dragon-asset", "/images/boss_dragon.png");
    this.load.image("resource-gold-pickup", "/Asset/pickups/gold-pile.png");
    this.load.image("special-room-shop", "/Asset/special-rooms/merchant-wagon.webp");
    this.load.image("special-room-shrine", "/Asset/special-rooms/echo-shrine.webp");
    this.load.image("special-room-shrine-used", "/Asset/special-rooms/echo-shrine-used.webp");
    this.load.image("special-room-trap", "/Asset/special-rooms/trap-device.webp");
    this.load.image("special-room-checkpoint", "/Asset/special-rooms/checkpoint-runestone.webp");
    this.load.image("special-room-gamble", "/Asset/special-rooms/gamble-wheel.webp");
    this.load.image("special-room-altar", "/Asset/special-rooms/blood-altar.webp");
    this.load.image("waypoint-circle-zone-1", "/Asset/waypoints/waypoint-circle-zone-1.png");
    this.load.image("waypoint-circle-zone-2", "/Asset/waypoints/waypoint-circle-zone-2.png");
    this.load.image("waypoint-circle-zone-3", "/Asset/waypoints/waypoint-circle-zone-3.png");

  }

  create(): void {
    this.renderZoneWorld(this.currentZone);
    this.roomRenderer = new RoomRenderer(this);
    gameBridge.emit("loading", { progress: 0.82, label: "렌더러 준비 중" });
    this.roomRenderer.create();
    const initialSnapshot = this.options.runtimeMode === "editor-core" && this.options.editorMap
      ? localCoreSession.start(buildEditorCoreWorld(this.options.editorMap), this.options.userId ?? "map-editor")
      : colyseusTransport.snapshot;
    const initialWaypointRooms = initialSnapshot
      ? this.activeWaypointRooms(initialSnapshot)
      : new Set<string>();
    this.renderedNetworkRoomKey = initialSnapshot ? this.waypointRenderKey(initialSnapshot) : "";
    gameBridge.emit("loading", { progress: 0.87, label: "월드 구성 중" });
    this.roomRenderer.renderWorld(this.zoneWorld, {
      decorSeed: this.runSeed,
      showBuildGrid: this.currentZone === 1,
      waypointRooms: initialWaypointRooms,
      revealedTrapRooms: initialSnapshot ? this.revealedTrapRooms(initialSnapshot) : undefined,
    });
    if (initialSnapshot) {
      const initialLocal = initialSnapshot.players.find((member) => member.isLocal)
        ?? initialSnapshot.players.find((member) => member.userId === this.options.userId);
      this.roomRenderer.updateSpecialRoomStates(initialSnapshot, initialLocal);
    }
    this.networkEnemyHpLayer = this.add.graphics().setDepth(28);
    this.waypointHoldBar = this.add.graphics().setDepth(42);
    const startCenter = this.zoneWorld.rooms.find((entry) => entry.room.id === this.currentRoomId)?.center ?? { x: 0, y: 0 };
    this.player = this.roomRenderer.createHero(this.options.heroClass, startCenter.x, startCenter.y);
    this.lastWalkablePlayerPosition = { ...startCenter };
    this.player.setVisible(false);
    this.configureCamera();
    this.createDeathOverlay();
    this.visionFog = new PlayerVisionFog(this);
    this.configureVisionWorld();
    this.configureInput();
    this.commandDisconnect = gameBridge.connect((command) => this.handleCommand(command));

    this.networkDisconnect = gameBridge.on("network", (snapshot) => this.syncNetworkState(snapshot));
    this.worldFrameDisconnect = gameBridge.on("worldFrame", (frame) => this.handleWorldFrame(frame));
    this.localInputDisconnect = gameBridge.on("localInput", (frame) => this.applyPredictedInput(frame));
    this.combatActionDisconnect = gameBridge.on("combatAction", (action) => this.receiveNetworkCombatAction(action));
    this.messageDisconnect = gameBridge.on("message", (message) => {
      this.message = message;
      this.emitSnapshot();
    });
    if (initialSnapshot) this.syncNetworkState(initialSnapshot);
    else this.renderNetworkPlaceholder();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.cleanup());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.cleanup());
    gameBridge.emit("loading", { progress: 1, label: "입장 완료" });
    gameBridge.emit("ready", undefined);
    this.emitSnapshot();
  }

  private configureCamera(): void {
    this.cameras.main.setBounds(0, 0, this.zoneWorld.bounds.width, this.zoneWorld.bounds.height);
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12);
    this.cameras.main.setZoom(1);
    this.cameras.main.setBackgroundColor(0x000000);
    this.cameras.main.fadeIn(350, 12, 20, 16);
  }

  private createDeathOverlay(): void {
    this.deathOverlay = this.add.rectangle(0, 0, this.scale.width, this.scale.height, 0x666666, 0.68)
      .setOrigin(0)
      .setScrollFactor(0)
      .setDepth(1_000)
      .setVisible(false);
    this.deathOverlayText = this.add.text(this.scale.width / 2, this.scale.height / 2, "부활 대기 중", {
      color: "#ffffff",
      fontFamily: "sans-serif",
      fontSize: "30px",
      fontStyle: "bold",
      stroke: "#222222",
      strokeThickness: 5,
    }).setOrigin(0.5).setScrollFactor(0).setDepth(1_001).setVisible(false);
  }

  private updateDeathPresentation(alive: boolean, respawnRemaining: number): void {
    if (!alive) {
      if (!this.deathPresentationActive) {
        this.deathPresentationActive = true;
        this.cameras.main.stopFollow();
        this.cameras.main.centerOn(this.player.x, this.player.y);
      }
      this.deathOverlay.setVisible(true);
      this.deathOverlayText
        .setText(`부활까지 ${Math.max(1, Math.ceil(respawnRemaining))}초`)
        .setVisible(true);
      return;
    }
    if (!this.deathPresentationActive) return;
    this.deathPresentationActive = false;
    this.deathOverlay.setVisible(false);
    this.deathOverlayText.setVisible(false);
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12);
  }

  /** Rebuilds and redraws the continuous world for a zone and re-anchors the camera. */
  private renderZoneWorld(zone: ZoneId, waypointRoomId?: string): void {
    const rooms = this.editorRooms.map((room) => ({
      id: room.id,
      zone: room.zone,
      x: room.x,
      y: room.y,
      width: room.width ?? 3,
      height: room.height ?? 3,
      type: room.type,
      connections: [...room.connections],
    }));
    const sourceConnections = this.authoredConnections.map((connection) => ({
      ...connection,
      from: editorCoreRoomId(connection.from),
      to: editorCoreRoomId(connection.to),
    }));
    this.authoredRenderWorld ??= buildEditorRenderWorld(rooms, sourceConnections);
    this.zoneWorld = this.authoredRenderWorld;
    this.physics.world.setBounds(this.zoneWorld.bounds.x, this.zoneWorld.bounds.y, this.zoneWorld.bounds.width, this.zoneWorld.bounds.height);
    this.cameras.main?.setBounds(this.zoneWorld.bounds.x, this.zoneWorld.bounds.y, this.zoneWorld.bounds.width, this.zoneWorld.bounds.height);
    this.roomRenderer?.renderWorld(this.zoneWorld, {
      decorSeed: `${this.runSeed}:authored:${zone}`,
      showBuildGrid: true,
      waypointRooms: waypointRoomId ? new Set([waypointRoomId]) : new Set(),
      revealedTrapRooms: this.latestNetwork ? this.revealedTrapRooms(this.latestNetwork) : undefined,
    });
    this.configureVisionWorld();
  }

  update(time: number, delta: number): void {
    const safeDeltaMs = Math.min(100, Math.max(0, delta));
    this.roomRenderer.updateCrosshair(this.input.activePointer);
    const localMember = this.latestNetwork?.players.find((member) => member.isLocal || member.userId === this.options.userId);
    const localRoomId = localMember?.roomId;
    const targetVisionRadius = this.visionRadiusForRoom(localRoomId);
    const visionStep = VISION_RADIUS_CHANGE_PER_SECOND * safeDeltaMs / 1_000;
    if (this.currentVisionRadius < targetVisionRadius) this.currentVisionRadius = Math.min(targetVisionRadius, this.currentVisionRadius + visionStep);
    else if (this.currentVisionRadius > targetVisionRadius) this.currentVisionRadius = Math.max(targetVisionRadius, this.currentVisionRadius - visionStep);
    const partyVisionSources = !this.latestNetwork || !localRoomId ? [] : this.latestNetwork.players
      .filter((member) => !(member.isLocal || member.userId === this.options.userId)
        && member.connected
        && member.alive
        && this.sharesNetworkVisionZone(localRoomId, member.roomId))
      .map((member): VisionRevealSource => {
        const transform = this.transformBuffer.sample(member.userId);
        return {
          id: `party:${member.userId}`,
          x: transform?.x ?? member.x,
          y: transform?.y ?? member.y,
          radius: this.visionRadiusForRoom(member.roomId),
        };
      });
    this.visionFog.update(
      this.player.x,
      this.player.y,
      Math.round(this.currentVisionRadius / 4) * 4,
      partyVisionSources,
    );
    if (this.options.runtimeMode === "editor-core") {
      const aim = this.aimAngle();
      const input = {
        x: Number(this.keys.D?.isDown) - Number(this.keys.A?.isDown),
        y: Number(this.keys.S?.isDown) - Number(this.keys.W?.isDown),
        aim,
        buttons: (Number(this.keys.SPACE?.isDown) | Number(Phaser.Input.Keyboard.JustDown(this.keys.SPACE))) << 2,
      };
      const localFrame = localCoreSession.tick(safeDeltaMs, input);
      if (localFrame.message) this.message = localFrame.message;
      this.localMovementX = localFrame.inputFrame.x;
      this.localMovementY = localFrame.inputFrame.y;
      this.syncNetworkState(localFrame.snapshot);
      this.handleWorldFrame(localFrame.frame);
    }
    this.materializePendingNetworkEnemies();
    this.flushPendingCombatActions();
    this.updateNetworkTransforms();
    this.updateWaypointHoldBar();
    const aim = this.aimAngle();
    if (this.options.runtimeMode !== "editor-core") colyseusTransport.setAim(aim);
    this.roomRenderer.updateHeroPose(this.player, this.localMovementX, this.localMovementY, time);
    this.snapshotAccumulator += safeDeltaMs;
    if (this.snapshotAccumulator >= 120) {
      this.snapshotAccumulator = 0;
      this.emitSnapshot();
    }
  }

  private updateWaypointHoldBar(): void {
    const graphics = this.waypointHoldBar;
    if (!graphics) return;
    graphics.clear();
    const snapshot = this.latestNetwork;
    const local = snapshot?.players.find((member) => member.isLocal || member.userId === this.options.userId);
    if (!snapshot || !local?.alive || !this.player.visible) return;
    const waypoint = snapshot.waypoints.find((candidate) => (
      candidate.active && candidate.roomId === local.roomId && candidate.holdProgress > 0
    ));
    if (!waypoint) return;
    const progress = Phaser.Math.Clamp(waypoint.holdProgress, 0, 1);
    const width = 72;
    const height = 8;
    const x = this.player.x - width / 2;
    const y = this.player.y - 58;
    graphics.fillStyle(0x050707, 0.9).fillRoundedRect(x - 3, y - 3, width + 6, height + 6, 3);
    graphics.lineStyle(1, 0xd7bd71, 0.92).strokeRoundedRect(x - 2, y - 2, width + 4, height + 4, 2);
    graphics.fillStyle(0x172522, 1).fillRect(x, y, width, height);
    graphics.fillGradientStyle(0x8ff4d0, 0x8ff4d0, 0x4ca8d8, 0x4ca8d8, 1);
    graphics.fillRect(x, y, Math.max(2, width * progress), height);
    graphics.fillStyle(0xffffff, 0.42).fillRect(x + 1, y + 1, Math.max(1, width * progress - 2), 1);
  }

  /**
   * Client-only vision hook for installable lights. A future lantern system can
   * call this whenever its authoritative world position or radius changes.
   */
  public upsertVisionRevealSource(source: VisionRevealSource): void {
    this.visionFog.upsertRevealSource(source);
  }

  public removeVisionRevealSource(id: string): void {
    this.visionFog.removeRevealSource(id);
  }

  private visionRadiusForRoom(roomId?: string): number {
    const trapVision = roomId !== undefined && this.latestNetwork?.specialRooms.some((room) => (
      room.roomId === roomId
      && room.trapDebuff === "vision"
      && ["warning", "wave", "hidden"].includes(room.trapPhase)
    ));
    if (trapVision) return Math.min(180, NIGHT_PLAYER_VISION_RADIUS);
    return this.localPhase === "night" ? NIGHT_PLAYER_VISION_RADIUS : PLAYER_VISION_RADIUS;
  }

  /** Server snapshots are the only simulation source while networked. */
  public syncNetworkState(snapshot: NetworkWorldSnapshot): void {
    if (snapshot.phase === "ended") this.localPhase = "ended";
    this.latestNetwork = snapshot;
    this.localPhase = snapshot.phase === "lobby" ? "day" : snapshot.phase;
    const local = snapshot.players.find((member) => member.isLocal)
      ?? snapshot.players.find((member) => member.userId === this.options.userId);
    if (!local) return;
    this.localPrediction ??= { x: local.x, y: local.y, roomId: local.roomId };
    const draftId = snapshot.localUpgradeDraft?.draftId ?? null;
    if (this.renderedNetworkDraftId !== draftId) {
      this.renderedNetworkDraftId = draftId;
      gameBridge.emit("upgrade", snapshot.localUpgradeDraft?.choices ?? []);
    }
    this.currentRoomId = local.roomId;
    this.currentZone = normalizeZone(snapshot.currentZone);
    const roomKey = this.waypointRenderKey(snapshot);
    if (this.renderedNetworkRoomKey !== roomKey) {
      this.renderedNetworkRoomKey = roomKey;
      this.renderNetworkRoom(snapshot);
    }
    this.roomRenderer.updateSpecialRoomStates(snapshot, local);
    this.syncNetworkPlayers(snapshot, local);
    this.roomRenderer.updateResourcePickups(new Set(snapshot.rooms.filter((room) => room.type === "resource" && room.cleared).map((room) => room.id)));
    this.roomRenderer.updateProgressionBarriers(this.lockedProgressionBarriers(snapshot));
    this.syncNetworkEnemies(snapshot, local);
    this.syncNetworkDrops(snapshot, local.roomId);
    this.emitSnapshot();
  }

  private handleWorldFrame(frame: WorldFrame): void {
    this.transformBuffer.push(frame);
    const snapshot = this.latestNetwork;
    const localState = snapshot?.players.find((member) => member.isLocal)
      ?? snapshot?.players.find((member) => member.userId === this.options.userId);
    const authoritative = frame.players.find((player) => player.id === this.options.userId || player.id === localState?.userId);
    if (!snapshot || !localState || !authoritative) return;
    if (!localState.alive) {
      this.localMovementX = 0;
      this.localMovementY = 0;
      this.localCorrection = null;
      this.localPrediction = { x: authoritative.x, y: authoritative.y, roomId: authoritative.roomId };
      this.player.setPosition(authoritative.x, authoritative.y).setVelocity(0);
      return;
    }
    let reconciled = { x: authoritative.x, y: authoritative.y, roomId: authoritative.roomId };
    const movementWorld = this.networkPredictionWorld(snapshot);
    for (const input of this.options.runtimeMode === "editor-core" ? [] : colyseusTransport.unacknowledgedInputs) {
      reconciled = predictPlayerTransform({
        ...reconciled,
        heroClass: localState.heroClass,
        frame: input,
        deltaSeconds: 1 / 60,
        rooms: snapshot.rooms,
        movementWorld,
      });
    }
    const visualX = this.player.x;
    const visualY = this.player.y;
    const error = Math.hypot(visualX - reconciled.x, visualY - reconciled.y);
    const hardSnap = this.options.runtimeMode === "editor-core"
      || (authoritative.flags & transformFlags.discontinuity) !== 0
      || error > 96;
    this.localPrediction = reconciled;
    if (hardSnap) {
      this.localCorrection = null;
      this.player.setPosition(reconciled.x, reconciled.y);
    } else if (error > 2) {
      this.localCorrection = {
        x: visualX - reconciled.x,
        y: visualY - reconciled.y,
        startedAt: performance.now(),
      };
    } else {
      this.localCorrection = null;
    }
  }

  private applyPredictedInput(frame: InputFrame): void {
    const snapshot = this.latestNetwork;
    const localState = snapshot?.players.find((member) => member.isLocal)
      ?? snapshot?.players.find((member) => member.userId === this.options.userId);
    if (!snapshot || !localState) return;
    if (!localState.alive) {
      this.localMovementX = 0;
      this.localMovementY = 0;
      this.localCorrection = null;
      this.localPrediction = { x: localState.x, y: localState.y, roomId: localState.roomId };
      this.player.setPosition(localState.x, localState.y).setVelocity(0);
      return;
    }
    this.localMovementX = frame.x;
    this.localMovementY = frame.y;
    const current = this.localPrediction ?? { x: localState.x, y: localState.y, roomId: localState.roomId };
    this.localPrediction = predictPlayerTransform({
      ...current,
      heroClass: localState.heroClass,
      frame,
      deltaSeconds: 1 / 60,
      rooms: snapshot.rooms,
      movementWorld: this.networkPredictionWorld(snapshot),
    });
  }

  private predictionWorldCache: { snapshot: NetworkWorldSnapshot; world: PredictionWorld } | null = null;

  private networkPredictionWorld(snapshot: NetworkWorldSnapshot): PredictionWorld {
    if (this.predictionWorldCache?.snapshot === snapshot) return this.predictionWorldCache.world;
    // The server only publishes discovered rooms. Progression gates must come
    // from the authored manifest or an undiscovered gate makes the client
    // believe the next zone is already open.
    const gateRoomIds = [...OFFICIAL_MAP_MANIFEST.world.gateRoomIds];
    const bossAccessible = areAuthoredBossGatesCleared(
      snapshot.day,
      gateRoomIds,
      snapshot.rooms,
    );
    const currentZoneGateIds = gateRoomIds.filter((gateRoomId) => (
      OFFICIAL_MAP_MANIFEST.world.rooms.find((room) => room.id === gateRoomId)?.zone === snapshot.currentZone
    ));
    const currentZoneCleared = currentZoneGateIds.length === 0 || currentZoneGateIds.every((gateRoomId) => (
      snapshot.rooms.some((room) => room.id === gateRoomId && room.cleared)
    ));
    const world: PredictionWorld = {
      ...(bossAccessible ? OFFICIAL_OPEN_PREDICTION_WORLD : OFFICIAL_LOCKED_PREDICTION_WORLD),
      maxAccessibleZone: currentZoneCleared
        ? Math.min(3, snapshot.currentZone + 1)
        : snapshot.currentZone,
      blockedRects: this.lockedProgressionBarriers(snapshot).map((barrier) => ({
        x: barrier.x - barrier.width / 2,
        y: barrier.y - barrier.height / 2,
        width: barrier.width,
        height: barrier.height,
      })),
    };
    this.predictionWorldCache = { snapshot, world };
    return world;
  }

  private updateNetworkTransforms(): void {
    const snapshot = this.latestNetwork;
    const localState = snapshot?.players.find((member) => member.isLocal)
      ?? snapshot?.players.find((member) => member.userId === this.options.userId);
    if (!snapshot || !localState) return;
    const now = performance.now();
    const poseTime = this.time.now;
    if (this.localPrediction) {
      const correctionAge = this.localCorrection ? now - this.localCorrection.startedAt : 100;
      const correctionScale = this.localCorrection ? Math.max(0, 1 - correctionAge / 100) : 0;
      this.player.setPosition(
        this.localPrediction.x + (this.localCorrection?.x ?? 0) * correctionScale,
        this.localPrediction.y + (this.localCorrection?.y ?? 0) * correctionScale,
      );
      this.player.setVisible(localState.alive).setActive(localState.alive && localState.connected);
      if (localState.alive) this.roomRenderer.updateHeroPose(this.player, this.localMovementX, this.localMovementY, poseTime);
      this.roomRenderer.updateHeroStatusEffect(localState.userId, this.player, heroStatusVisual(snapshot, localState));
      if (correctionScale === 0) this.localCorrection = null;
    }
    for (const member of snapshot.players) {
      if (member.isLocal || member.userId === this.options.userId) continue;
      const sprite = this.remotePlayers.get(member.userId);
      const transform = this.transformBuffer.sample(member.userId);
      if (!sprite) continue;
      const resolved = transform ?? member;
      const point = clampToWorld(this.zoneWorld.bounds, resolved.x, resolved.y);
      const visible = this.sharesNetworkVisionZone(localState.roomId, resolved.roomId)
        && shouldRenderPartyMember({ ...member, x: point.x, y: point.y });
      sprite.setPosition(point.x, point.y).setVisible(visible);
      this.roomRenderer.updateHeroPose(sprite, transform?.vx ?? 0, transform?.vy ?? 0, poseTime);
      this.roomRenderer.updateHeroStatusEffect(member.userId, sprite, heroStatusVisual(snapshot, member));
    }
    for (const enemy of snapshot.enemies) {
      const sprite = this.networkEnemies.get(enemy.id);
      const transform = this.transformBuffer.sample(enemy.id);
      if (!sprite) continue;
      const resolved = transform ?? enemy;
      const point = clampToWorld(this.zoneWorld.bounds, resolved.x, resolved.y);
      const visible = enemy.alive
        && this.sharesNetworkVisionZone(localState.roomId, resolved.roomId);
      sprite.setPosition(point.x, point.y).setVisible(visible);
      this.roomRenderer.updateEnemyPose(
        sprite,
        this.networkEnemyKinds.get(enemy.id) ?? "static",
        undefined,
        undefined,
        transform?.vx ?? 0,
        transform?.vy ?? 0,
        transform?.aim,
      );
    }
    this.drawNetworkEnemyHpBars(snapshot, localState, now);
  }

  private configureInput(): void {
    if (!this.input.keyboard) return;
    this.keys = this.input.keyboard.addKeys("W,A,S,D,Q,E,SPACE,B") as typeof this.keys;
  }

  private handleCommand(command: GameCommand): void {
    if (command.type === "choose-upgrade") {
      if (this.options.runtimeMode === "editor-core") {
        const draftId = this.latestNetwork?.localUpgradeDraft?.draftId;
        if (draftId) localCoreSession.chooseUpgrade(draftId, command.upgradeId);
      } else {
        const draftId = this.latestNetwork?.localUpgradeDraft?.draftId;
        if (draftId) colyseusTransport.chooseUpgrade(draftId, command.upgradeId);
      }
    } else if (command.type === "travel") {
      if (this.options.runtimeMode === "editor-core") localCoreSession.requestTravel(command.waypointId, command.destinationId);
      else colyseusTransport.requestTravel(command.waypointId, command.destinationId);
    } else if (command.type === "interact") {
      if (this.options.runtimeMode === "editor-core") localCoreSession.interact(command.targetId);
      else colyseusTransport.interact(command.targetId);
    } else if (command.type === "special-room") {
      if (this.options.runtimeMode === "editor-core") localCoreSession.specialCommand(command.action, command.payload);
      else colyseusTransport.specialCommand(command.action, command.payload);
    } else if (command.type === "return-base") {
      if (this.options.runtimeMode === "editor-core") localCoreSession.recall();
      else colyseusTransport.requestRecall();
    }
  }

  private renderNetworkPlaceholder(): void {
    this.message = "서버 방 상태를 기다리는 중입니다.";
  }

  private renderNetworkRoom(snapshot: NetworkWorldSnapshot): void {
    const waypointRooms = this.activeWaypointRooms(snapshot);
    this.roomRenderer.updateTrapReveals(this.zoneWorld, this.revealedTrapRooms(snapshot));
    this.roomRenderer.updateWaypoints(this.zoneWorld, waypointRooms);
  }

  private lockedProgressionBarriers(snapshot: NetworkWorldSnapshot): ProgressionBarrier[] {
    const progressionWorld = this.progressionWorld;
    if (!progressionWorld) return [];
    const roomState = new Map(snapshot.rooms.map((room) => [room.id, room]));
    const progressionRooms = new Map<string, (typeof progressionWorld.rooms)[number]>(
      progressionWorld.rooms.map((room) => [room.id, room]),
    );
    const gateRoomIds = progressionWorld.gateRoomIds;
    const bossAccessible = areAuthoredBossGatesCleared(snapshot.day, gateRoomIds, snapshot.rooms);
    const lockedConnections = progressionWorld.connections.filter((connection) => {
      const from = progressionRooms.get(connection.from);
      const to = progressionRooms.get(connection.to);
      if (!from || !to) return false;
      const trapRoom = from.kind === "trap" ? from : to.kind === "trap" ? to : null;
      const trapState = trapRoom ? snapshot.specialRooms.find((room) => room.roomId === trapRoom.id) : null;
      if (trapState && ["warning", "wave", "hidden"].includes(trapState.trapPhase)) return true;
      if (from.id === progressionWorld.bossRoomId || to.id === progressionWorld.bossRoomId) return !bossAccessible;
      if (from.zone === to.zone) return false;
      const lowerZone = Math.min(from.zone, to.zone);
      const gateIds = gateRoomIds.filter((gateRoomId) => progressionRooms.get(gateRoomId)?.zone === lowerZone);
      return gateIds.length > 0 && gateIds.some((gateId) => !roomState.get(gateId)?.cleared);
    });
    const renderedAnchor = this.zoneWorld.rooms[0];
    const progressionAnchor = renderedAnchor ? progressionRooms.get(renderedAnchor.room.id) : undefined;
    const offsetX = renderedAnchor && progressionAnchor ? renderedAnchor.rect.x - progressionAnchor.rect.x : 0;
    const offsetY = renderedAnchor && progressionAnchor ? renderedAnchor.rect.y - progressionAnchor.rect.y : 0;
    return lockedConnections.map((connection) => {
      const from = progressionRooms.get(connection.from);
      const to = progressionRooms.get(connection.to);
      const trapRoomId = from?.kind === "trap" ? from.id : to?.kind === "trap" ? to.id : null;
      const trapState = trapRoomId ? snapshot.specialRooms.find((room) => room.roomId === trapRoomId) : null;
      if (trapState && ["warning", "wave", "hidden"].includes(trapState.trapPhase) && connection.trapBarrier) return {
        x: connection.trapBarrier.x + offsetX + connection.trapBarrier.width / 2,
        y: connection.trapBarrier.y + offsetY + connection.trapBarrier.height / 2,
        width: connection.trapBarrier.width,
        height: connection.trapBarrier.height,
        kind: "trap" as const,
      };
      if (connection.lockBarrier) return {
        x: connection.lockBarrier.x + offsetX + connection.lockBarrier.width / 2,
        y: connection.lockBarrier.y + offsetY + connection.lockBarrier.height / 2,
        width: connection.lockBarrier.width,
        height: connection.lockBarrier.height,
        kind: "progression" as const,
      };
      const segment = [...connection.floorRects].sort((left, right) => Math.max(right.width, right.height) - Math.max(left.width, left.height))[0]!;
      const horizontal = segment.width >= segment.height;
      return {
        x: segment.x + offsetX + segment.width / 2,
        y: segment.y + offsetY + segment.height / 2,
        width: horizontal ? 18 : Math.max(44, segment.width - 18),
        height: horizontal ? Math.max(44, segment.height - 18) : 18,
        kind: "progression" as const,
      };
    });
  }

  private activeWaypointRooms(snapshot: NetworkWorldSnapshot): Set<string> {
    return new Set(snapshot.waypoints.filter((waypoint) => waypoint.active).map((waypoint) => waypoint.roomId));
  }

  private waypointRenderKey(snapshot: NetworkWorldSnapshot): string {
    const waypoints = [...this.activeWaypointRooms(snapshot)].sort().join("|");
    const traps = [...this.revealedTrapRooms(snapshot)].sort().join("|");
    return `${waypoints}::traps:${traps}`;
  }

  private revealedTrapRooms(snapshot: NetworkWorldSnapshot): Set<string> {
    return new Set(snapshot.specialRooms.filter((room) => room.kind === "trap").map((room) => room.roomId));
  }

  private sharesNetworkVisionZone(viewerRoomId: string, candidateRoomId: string): boolean {
    if (viewerRoomId === candidateRoomId) return true;
    // The official authored world is one continuous render/LOS area even when
    // room themes advance the gameplay zone counter.
    if (viewerRoomId.startsWith("editor:") && candidateRoomId.startsWith("editor:")) return true;
    const viewerZone = this.latestNetwork?.rooms.find((room) => room.id === viewerRoomId)?.zone;
    const candidateZone = this.latestNetwork?.rooms.find((room) => room.id === candidateRoomId)?.zone;
    return viewerZone !== undefined && viewerZone === candidateZone;
  }

  private syncNetworkPlayers(snapshot: NetworkWorldSnapshot, local: PartyMemberSnapshot): void {
    const players = snapshot.players;
    const activeIds = new Set(players.map((member) => member.userId));
    for (const [userId, sprite] of this.remotePlayers) {
      if (!activeIds.has(userId)) {
        this.roomRenderer.updateHeroStatusEffect(userId, sprite, null);
        sprite.destroy();
        this.remotePlayers.delete(userId);
        this.networkPlayerAttackSequence.delete(userId);
        this.networkPlayerSkillSequence.delete(userId);
      }
    }
    for (const member of players) {
      const isLocal = member.isLocal || member.userId === this.options.userId;
      const sprite = isLocal
        ? this.player
        : this.remotePlayers.get(member.userId) ?? this.roomRenderer.createHero(member.heroClass, member.x, member.y, 0.82);
      if (!isLocal && !this.remotePlayers.has(member.userId)) this.remotePlayers.set(member.userId, sprite);
      if (isLocal && !this.localPrediction) {
        this.localPrediction = { x: member.x, y: member.y, roomId: member.roomId };
        sprite.setPosition(member.x, member.y);
      }
      if (isLocal && !member.alive) {
        this.localMovementX = 0;
        this.localMovementY = 0;
        this.localCorrection = null;
        this.localPrediction = { x: member.x, y: member.y, roomId: member.roomId };
        sprite.setPosition(member.x, member.y).setVelocity(0);
      }
      const visible = isLocal
        ? member.alive
        : (
        this.sharesNetworkVisionZone(local.roomId, member.roomId)
        && shouldRenderPartyMember(member)
      );
      sprite.setVisible(visible).setActive(member.connected && member.alive);
      sprite.setAlpha(isLocal ? 1 : 0.82);
      const previousAttackSequence = this.networkPlayerAttackSequence.get(member.userId);
      if (this.options.runtimeMode === "editor-core" && previousAttackSequence !== undefined && member.attackSequence > previousAttackSequence && visible) {
        const target = snapshot.enemies.find((enemy) => enemy.id === member.attackTargetId);
        if (target) this.roomRenderer.showClassAttack(member.heroClass, sprite, target.x, target.y, member.aim, member.attackCritical, member.level);
      }
      this.networkPlayerAttackSequence.set(member.userId, member.attackSequence);
      const previousSkillSequence = this.networkPlayerSkillSequence.get(member.userId);
      if (previousSkillSequence !== undefined && (member.skillSequence ?? 0) > previousSkillSequence && visible) {
        const skillId = member.lastSkillId;
        if (skillId === "dash") {
          this.roomRenderer.showDodge(
            sprite,
            member.skillTargetX ?? member.x,
            member.skillTargetY ?? member.y,
            member.skillOriginX ?? sprite.x,
            member.skillOriginY ?? sprite.y,
          );
        } else if (skillId === "q" || skillId === "e") {
          this.roomRenderer.showAutoSkill(member.heroClass, skillId, sprite, member.skillTargetX ?? member.x, member.skillTargetY ?? member.y, member.skillRadius ?? 0);
        }
      }
      this.networkPlayerSkillSequence.set(member.userId, member.skillSequence ?? 0);
    }
    this.updateDeathPresentation(local.alive, local.respawnRemaining ?? 0);
  }

  private receiveNetworkCombatAction(action: CombatActionEvent): void {
    if (this.renderedCombatActionIds.has(action.sequence)) return;
    if (this.renderNetworkCombatAction(action)) this.rememberCombatAction(action.sequence);
    else if (this.pendingCombatActions.length < 256) {
      this.pendingCombatActions.push({ action, expiresAt: performance.now() + 1_000 });
    }
  }

  private networkPlayerVisualPosition(userId: string | null): RenderPoint | null {
    if (!userId) return null;
    const member = this.latestNetwork?.players.find((candidate) => candidate.userId === userId);
    if (!member) return null;
    const sprite = member.isLocal || member.userId === this.options.userId
      ? this.player : this.remotePlayers.get(member.userId);
    return sprite?.active && sprite.visible ? { x: sprite.x, y: sprite.y } : null;
  }

  private renderNetworkCombatAction(action: CombatActionEvent): boolean {
    if (action.attackerType === "player") {
      const member = this.latestNetwork?.players.find((candidate) => candidate.userId === action.attackerId);
      if (!member || !action.heroClass) return false;
      const sprite = member.isLocal || member.userId === this.options.userId
        ? this.player : this.remotePlayers.get(member.userId);
      if (!sprite?.active || !sprite.visible) return false;
      this.roomRenderer.showClassAttack(action.heroClass, sprite, action.targetX, action.targetY, action.aim, action.critical, member.level);
      return true;
    }
    const sprite = this.networkEnemies.get(action.attackerId);
    if (!sprite?.active || !sprite.visible) return false;
    if (action.actionKind === "melee") {
      const target = alignEnemyAttackToRenderTimeline(
        action,
        { x: sprite.x, y: sprite.y },
        this.networkPlayerVisualPosition(action.targetId),
      );
      this.roomRenderer.updateEnemyPose(
        sprite,
        this.networkEnemyKinds.get(action.attackerId) ?? "static",
        target.x,
        target.y,
      );
      this.roomRenderer.showEnemyMeleeAttack(sprite, target.x, target.y);
    } else {
      const enemy = this.latestNetwork?.enemies.find((candidate) => candidate.id === action.attackerId);
      if (!enemy || !action.patternKind) return false;
      const kind: RenderedEnemyKind = enemy.kind === "boss" || enemy.behavior === "boss" ? "boss"
        : enemy.kind === "gate" || enemy.behavior === "gate" ? "gate" : "hidden";
      this.roomRenderer.updateEnemyPattern(
        enemy.id,
        patternTier(kind),
        action.patternKind,
        action.actionKind === "pattern-telegraph" ? "telegraph" : "idle",
        enemy.patternIndex,
        sprite.x,
        sprite.y,
        true,
      );
      if (action.actionKind === "pattern-resolve") {
        const isBoss = kind === "boss";
        this.roomRenderer.showImpact(action.targetX, action.targetY, isBoss ? 160 : 38, isBoss ? 0xff5533 : 0xff596c);
        if (isBoss) this.cameras.main.shake(250, 0.01);
      }
    }
    return true;
  }

  private flushPendingCombatActions(): void {
    const now = performance.now();
    for (let index = this.pendingCombatActions.length - 1; index >= 0; index -= 1) {
      const pending = this.pendingCombatActions[index]!;
      if (pending.expiresAt <= now || this.renderedCombatActionIds.has(pending.action.sequence)) {
        this.pendingCombatActions.splice(index, 1);
      } else if (this.renderNetworkCombatAction(pending.action)) {
        this.rememberCombatAction(pending.action.sequence);
        this.pendingCombatActions.splice(index, 1);
      }
    }
  }

  private rememberCombatAction(sequence: number): void {
    this.renderedCombatActionIds.add(sequence);
    this.renderedCombatActionOrder.push(sequence);
    if (this.renderedCombatActionOrder.length <= 512) return;
    const expired = this.renderedCombatActionOrder.shift();
    if (expired !== undefined) this.renderedCombatActionIds.delete(expired);
  }

  private syncNetworkEnemies(snapshot: NetworkWorldSnapshot, local: PartyMemberSnapshot): void {
    const enemies = snapshot.enemies;
    const activeIds = new Set(enemies.filter((enemy) => enemy.alive).map((enemy) => enemy.id));
    for (const [id, sprite] of this.networkEnemies) {
      if (!activeIds.has(id)) {
        this.roomRenderer.updateEnemyPattern(id, "hidden", "fan", "idle", 0, 0, 0, false);
        this.roomRenderer.releaseNetworkEnemy(this.networkEnemyKinds.get(id) ?? "static", sprite);
        this.networkEnemies.delete(id);
        this.networkEnemyKinds.delete(id);
        this.networkEnemyHp.delete(id);
        this.networkEnemyAttackSequence.delete(id);
      }
    }
    for (const id of this.pendingNetworkEnemySet) {
      if (!activeIds.has(id)) this.pendingNetworkEnemySet.delete(id);
    }

    const newVisibleEnemies = enemies
      .filter((enemy) => enemy.alive
        && this.sharesNetworkVisionZone(local.roomId, enemy.roomId)
        && !this.networkEnemies.has(enemy.id)
        && !this.pendingNetworkEnemySet.has(enemy.id))
      .sort((left, right) => (
        Phaser.Math.Distance.Squared(local.x, local.y, left.x, left.y)
        - Phaser.Math.Distance.Squared(local.x, local.y, right.x, right.y)
      ));
    for (const enemy of newVisibleEnemies) {
      this.pendingNetworkEnemySet.add(enemy.id);
      this.pendingNetworkEnemyIds.push(enemy.id);
    }

    for (const enemy of enemies) {
      const kind: RenderedEnemyKind = enemy.kind === "boss" || enemy.behavior === "boss" ? "boss"
        : enemy.kind === "gate" || enemy.behavior === "gate" ? "gate"
          : enemy.kind === "hidden" || enemy.kind === "hidden-ranged" || enemy.behavior === "hidden" ? "hidden"
            : enemy.kind === "invader" || enemy.behavior === "invader" ? "invader" : "static";
      const sprite = this.networkEnemies.get(enemy.id);
      if (!sprite) continue;
      const visible = enemy.alive
        && this.sharesNetworkVisionZone(local.roomId, enemy.roomId);

      const previousHp = this.networkEnemyHp.get(enemy.id);
      if (previousHp !== undefined && enemy.hp < previousHp && visible) {
        this.roomRenderer.showImpact(sprite.x, sprite.y, 30, 0xffffff);
        if (kind === "static" || kind === "invader") {
          this.roomRenderer.showKnockbackEffect(sprite, sprite.x, sprite.y, enemy.x, enemy.y);
        }
      }
      this.networkEnemyHp.set(enemy.id, enemy.hp);

      if (kind === "boss") {
        const isDragonPhase = enemy.hp <= enemy.maxHp * 0.5;
        const currentPhase = isDragonPhase ? "dragon" : "bull";
        if (sprite.getData("bossPhase") !== currentPhase) {
          sprite.setData("bossPhase", currentPhase);
          sprite.setData("hasBullMotion", false);
          sprite.setData("hasDragonMotion", false);
          this.tweens.killTweensOf(sprite);
          if (isDragonPhase && previousHp !== undefined) {
            this.roomRenderer.showImpact(enemy.x, enemy.y, 240, 0xff2266);
            this.cameras.main.shake(350, 0.015);
          }
        }
      }

      // attackSequence is state-recovery metadata; live visuals use combat.action.
      this.networkEnemyAttackSequence.set(enemy.id, enemy.attackSequence);
      sprite.setVisible(visible).setActive(enemy.alive);
      this.roomRenderer.updateEnemyPattern(
        enemy.id,
        patternTier(kind),
        enemy.patternKind,
        enemy.patternPhase,
        enemy.patternIndex,
        sprite.x,
        sprite.y,
        visible,
      );
    }
  }

  private materializePendingNetworkEnemies(): void {
    const snapshot = this.latestNetwork;
    if (!snapshot || this.pendingNetworkEnemyIds.length === 0) return;
    const local = snapshot.players.find((member) => member.isLocal)
      ?? snapshot.players.find((member) => member.userId === this.options.userId);
    if (!local) return;
    const startedAt = performance.now();
    let created = 0;
    while (
      this.pendingNetworkEnemyIds.length > 0
      && created < NETWORK_ENEMY_SPAWN_LIMIT
      && performance.now() - startedAt < NETWORK_ENEMY_SPAWN_BUDGET_MS
    ) {
      const id = this.pendingNetworkEnemyIds.shift() as string;
      if (!this.pendingNetworkEnemySet.delete(id) || this.networkEnemies.has(id)) continue;
      const enemy = snapshot.enemies.find((candidate) => candidate.id === id);
      if (!enemy?.alive || !this.sharesNetworkVisionZone(local.roomId, enemy.roomId)) continue;
      const kind: RenderedEnemyKind = enemy.kind === "boss" || enemy.behavior === "boss" ? "boss"
        : enemy.kind === "gate" || enemy.behavior === "gate" ? "gate"
          : enemy.kind === "hidden" || enemy.kind === "hidden-ranged" || enemy.behavior === "hidden" ? "hidden"
            : enemy.kind === "invader" || enemy.behavior === "invader" ? "invader" : "static";
      const sprite = this.roomRenderer.acquireNetworkEnemy(kind, enemy.x, enemy.y);
      this.networkEnemies.set(id, sprite);
      this.networkEnemyKinds.set(id, kind);
      this.networkEnemyHp.set(id, enemy.hp);
      this.networkEnemyAttackSequence.set(id, enemy.attackSequence);
      created += 1;
    }
  }

  private drawNetworkEnemyHpBars(snapshot: NetworkWorldSnapshot, local: PartyMemberSnapshot, now: number): void {
    if (now - this.lastNetworkHpDrawAt < 1000 / 30) return;
    this.lastNetworkHpDrawAt = now;
    const graphics = this.networkEnemyHpLayer;
    graphics.clear().setPosition(0, 0);
    const view = this.cameras.main.worldView;
    for (const enemy of snapshot.enemies) {
      const sprite = this.networkEnemies.get(enemy.id);
      if (!sprite?.visible || sprite.getData("isEmerging") || !enemy.alive || enemy.hp <= 0
        || !this.sharesNetworkVisionZone(local.roomId, enemy.roomId)) continue;
      if (sprite.x < view.left - 80 || sprite.x > view.right + 80
        || sprite.y < view.top - 80 || sprite.y > view.bottom + 80) continue;
      const kind = this.networkEnemyKinds.get(enemy.id) ?? "static";
      const isBoss = kind === "boss";
      const isElite = kind === "gate" || kind === "hidden";
      const width = isBoss ? 56 : isElite ? 38 : 28;
      const height = isBoss ? 6 : 4;
      const offsetY = isBoss ? 36 : isElite ? 26 : 20;
      const barX = sprite.x - width / 2;
      const barY = sprite.y - offsetY;
      const hpRatio = Math.max(0, Math.min(1, enemy.hp / Math.max(1, enemy.maxHp)));
      graphics.fillStyle(0x0a0d0e, 0.85).fillRect(barX - 1, barY - 1, width + 2, height + 2);
      graphics.fillStyle(0x380b0b, 0.95).fillRect(barX, barY, width, height);
      const fillColor = isBoss
        ? hpRatio > 0.5 ? 0xffb700 : hpRatio > 0.25 ? 0xff6600 : 0xe62e2e
        : hpRatio <= 0.25 ? 0xeb3b3b : hpRatio <= 0.5 ? 0xf5b942 : 0x2cd467;
      graphics.fillStyle(fillColor, 1).fillRect(barX, barY, Math.max(1, width * hpRatio), height);
      graphics.fillStyle(0xffffff, 0.35).fillRect(barX, barY, Math.max(1, width * hpRatio), 1);
    }
  }

  private syncNetworkDrops(snapshot: NetworkWorldSnapshot, localRoomId: string): void {
    const visibleDrops = snapshot.drops.filter((drop) => drop.roomId === localRoomId);
    const visibleIds = new Set(visibleDrops.map((drop) => drop.id));
    const liveIds = new Set(snapshot.drops.map((drop) => drop.id));
    for (const [id, object] of this.networkDrops) {
      if (!visibleIds.has(id)) {
        object.destroy();
        this.networkDrops.delete(id);
      }
    }
    for (const id of this.networkDropRequests.keys()) {
      if (!liveIds.has(id)) this.networkDropRequests.delete(id);
    }
    for (const drop of visibleDrops) {
      const object = this.networkDrops.get(drop.id) ?? this.roomRenderer.createDrop(drop.x, drop.y, drop.rarity);
      if (!this.networkDrops.has(drop.id)) {
        object.setSize(96, 66).setInteractive({ useHandCursor: true });
        object.on("pointerdown", () => {
          const lastRequestedAt = this.networkDropRequests.get(drop.id) ?? -Infinity;
          if (this.time.now - lastRequestedAt < 750) return;
          this.networkDropRequests.set(drop.id, this.time.now);
          if (this.options.runtimeMode === "editor-core") localCoreSession.equip(drop.id);
          else colyseusTransport.equip(drop.id);
          this.message = `${drop.rarity === "mythic" ? "신화" : "전설"} 개인 장비 교체를 요청했습니다.`;
          this.emitSnapshot();
        });
        this.networkDrops.set(drop.id, object);
      }
      object.setPosition(drop.x, drop.y).setVisible(true).setActive(true);
    }
  }

  private emitSnapshot(): void {
    gameBridge.emit("snapshot", this.createNetworkGameSnapshot());
  }

  private createNetworkGameSnapshot(): GameSnapshot {
    const state = this.latestNetwork;
    const local = state?.players.find((member) => member.isLocal || member.userId === this.options.userId);
    const phase: Phase = state?.phase === "lobby" || !state ? "day" : state.phase;
    const roomMap = state?.rooms ?? [];
    const remaining = state?.phaseEndsAt
      ? Math.max(0, (state.phaseEndsAt - (state.serverTime + Math.max(0, Date.now() - state.serverTime))) / 1000)
      : 0;
    const networkEnemyList = state?.enemies ?? [];
    const boss = networkEnemyList.find((enemy) => (enemy.kind === "boss" || enemy.behavior === "boss") && enemy.alive);
    const currentRoom = roomMap.find((room) => room.id === local?.roomId);
    const activeWaypoint = state?.waypoints.find((waypoint) => waypoint.roomId === local?.roomId && waypoint.active);
    const waypointCenter = activeWaypoint ? this.waypointWorldCenter(activeWaypoint.roomId) : undefined;
    const waypointNearby = Boolean(activeWaypoint && local && waypointCenter
      && Phaser.Math.Distance.Between(local.x, local.y, waypointCenter.x, waypointCenter.y) <= 95);
    const shared = resolveSharedPartyProgress({
      baseHp: state?.baseHp ?? 0,
      baseMaxHp: state?.baseMaxHp ?? BASE_MAX_HP,
      gold: state?.gold ?? 0,
      currentZone: state?.currentZone ?? 1,
      teamLevel: state?.teamLevel ?? 1,
      teamXp: state?.teamXp ?? 0,
      teamXpToNext: state?.teamXpToNext ?? 0,
      rooms: roomMap,
    });
    return {
      worldMode: this.options.runtimeMode === "editor-core" ? "editor" : "official",
      running: phase !== "ended",
      phase,
      phaseLabel: PHASE_LABELS[phase],
      day: state?.day ?? 1,
      phaseRemaining: remaining,
      elapsed: state?.elapsed ?? 0,
      hp: local?.hp ?? 0,
      maxHp: local?.maxHp ?? 0,
      baseHp: shared.baseHp,
      baseMaxHp: shared.baseMaxHp,
      level: shared.level,
      xp: shared.xp,
      xpToNext: shared.xpToNext,
      gold: shared.gold,
      teamPower: state?.players.reduce((sum, member) => sum + member.teamPower, 0) ?? 0,
      gatesDestroyed: shared.gatesDestroyed,
      buildMode: null,
      qCooldown: local?.qCooldown ?? 0,
      eCooldown: local?.eCooldown ?? 0,
      dashCooldown: local?.dashCooldown ?? 0,
      bossAvailable: currentRoom?.type === "gate" && currentRoom.zone === 3 && currentRoom.cleared,
      bossHp: boss?.hp ?? null,
      bossMaxHp: boss?.maxHp ?? null,
      message: this.message,
      upgrades: [],
      stats: { ...(state?.stats ?? this.stats) },
      party: state?.players ?? [],
      currentZone: shared.currentZone,
      currentRoomId: local?.roomId ?? this.currentRoomId,
      roomsExplored: shared.roomsExplored,
      roomMap: shared.roomMap,
      minimap: state?.minimap ?? null,
      explorationPercent: state?.minimap ? calculateExplorationPercent(state.minimap.geometry, state.minimap.explorationMask) : 0,
      equipment: local?.equipment ?? [],
      combatStats: local?.combatStats ?? {
        attackDamage: CLASS_DEFINITIONS[this.options.heroClass].stats.attack,
        defense: CLASS_DEFINITIONS[this.options.heroClass].stats.defense,
        criticalChance: 0,
        criticalDamage: 150,
        attacksPerSecond: 1_000 / CLASS_DEFINITIONS[this.options.heroClass].stats.attackIntervalMs,
        attackRange: CLASS_DEFINITIONS[this.options.heroClass].stats.attackRange,
        moveSpeed: CLASS_DEFINITIONS[this.options.heroClass].stats.moveSpeed,
      },
      buildSupported: false,
      inBuildZone: false,
      waypoint: {
        nearby: waypointNearby,
        id: waypointNearby ? activeWaypoint?.id ?? null : null,
        destinationId: activeWaypoint?.destinationId ?? "",
        holdProgress: activeWaypoint?.holdProgress ?? state?.waypointHoldProgress ?? 0,
      },
      specialRoom: currentRoom && ["shop", "shrine", "trap", "checkpoint", "gamble", "altar", "gold"].includes(currentRoom.type) ? {
        kind: currentRoom.type,
        state: state?.specialRooms.find((entry) => entry.roomId === currentRoom.id) ?? null,
        offers: state?.shopOffers.filter((offer) => offer.roomId === currentRoom.id) ?? [],
        inventory: local?.inventory ?? [],
        respawnRoomId: local?.respawnRoomId ?? "",
        gambleAttempts: local?.gambleAttempts ?? 0,
        altarAttempts: local?.altarAttempts ?? 0,
        shrineBuff: local?.shrineBuff ?? "",
        shrineBuffRemaining: local?.shrineBuffRemaining ?? 0,
      } : null,
    };
  }

  private waypointWorldCenter(roomId: string): { x: number; y: number } | undefined {
    return this.zoneWorld.rooms.find((entry) => entry.room.id === roomId)?.center;
  }

  private aimAngle(): number {
    const pointer = this.input.activePointer;
    const worldPointer = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    return aimAngleBetween(this.player, worldPointer);
  }

  private cleanup(): void {
    if (this.options.runtimeMode === "editor-core") localCoreSession.stop();
    this.commandDisconnect?.();
    this.networkDisconnect?.();
    this.worldFrameDisconnect?.();
    this.localInputDisconnect?.();
    this.messageDisconnect?.();
    this.combatActionDisconnect?.();
    this.commandDisconnect = undefined;
    this.networkDisconnect = undefined;
    this.worldFrameDisconnect = undefined;
    this.localInputDisconnect = undefined;
    this.messageDisconnect = undefined;
    this.combatActionDisconnect = undefined;
    this.transformBuffer.clear();
    this.input.removeAllListeners();
    for (const sprite of this.remotePlayers.values()) sprite.destroy();
    for (const sprite of this.networkEnemies.values()) sprite.destroy();
    this.networkEnemyHpLayer?.destroy();
    this.waypointHoldBar?.destroy();
    for (const drop of this.networkDrops.values()) drop.destroy();
    this.remotePlayers.clear();
    this.networkEnemies.clear();
    this.networkEnemyKinds.clear();
    this.pendingNetworkEnemyIds.length = 0;
    this.pendingNetworkEnemySet.clear();
    this.networkEnemyHp.clear();
    this.networkEnemyAttackSequence.clear();
    this.networkDrops.clear();
    this.networkDropRequests.clear();
    this.visionFog?.destroy();
    this.roomRenderer?.destroy();
  }

  private configureVisionWorld(): void {
    if (!this.visionFog || !this.zoneWorld) return;
    const revision = this.zoneWorld.wallSegments
      .map((segment) => `${segment.x1},${segment.y1},${segment.x2},${segment.y2}`)
      .join("|");
    this.visionFog.setWorld(this.zoneWorld.wallSegments, revision);
  }
}

function heroStatusVisual(
  snapshot: NetworkWorldSnapshot,
  member: PartyMemberSnapshot,
): { key: string; label: string; color: number } | null {
  const activeTrap = snapshot.specialRooms.find((room) => (
    room.kind === "trap"
    && room.roomId === member.roomId
    && room.trapParticipants.includes(member.userId)
    && ["warning", "wave", "hidden"].includes(room.trapPhase)
  ));
  if (activeTrap?.trapDebuff) {
    const visual = TRAP_STATUS_VISUALS[activeTrap.trapDebuff] ?? { label: "함정 디버프", color: 0xd04a55 };
    return { key: `trap:${activeTrap.roomId}:${activeTrap.trapDebuff}`, ...visual };
  }
  if (member.shrineBuff) {
    const visual = SHRINE_STATUS_VISUALS[member.shrineBuff] ?? { label: "성소의 축복", color: 0xd7b7ff };
    return { key: `shrine:${member.shrineBuff}`, ...visual };
  }
  return null;
}

function normalizeZone(value: number): ZoneId {
  if (value === 2 || value === 3) return value;
  return 1;
}

function patternTier(kind: RenderedEnemyKind): "hidden" | "gate" | "boss" {
  if (kind === "boss") return "boss";
  if (kind === "gate") return "gate";
  return "hidden";
}
