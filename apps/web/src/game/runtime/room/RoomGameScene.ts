import * as Phaser from "phaser";
import {
  ACTOR_COLLISION_RADIUS,
  AUGMENT_BY_ID,
  autoSkillDefinition,
  CLASS_COMBAT_RULES,
  createAugmentDraft,
  createSeededRandom,
  enemyFanPatternAngles,
  enemyFloorPatternCircles,
  enemyPatternConfig,
  generateThreeZoneMap,
  OFFICIAL_MAP_MANIFEST,
  createExplorationMask,
  createMiniMapGrid,
  explorationPercent as calculateExplorationPercent,
  rectToMiniMapSurface,
  revealAround,
  rollPersonalHiddenDrop,
  type AugmentId,
  type CoreWorldDefinition,
  type PersonalHiddenDrop,
  type ThreeZoneMap,
  type ZoneId,
} from "@five-days/game-core";
import { BUILDINGS, DIFFICULTY } from "../../content/balance";
import { CLASS_DEFINITIONS } from "../../content/classes";
import { UPGRADE_MAP } from "../../content/upgrades";
import type {
  BuildMode,
  EquipmentSummary,
  GameResult,
  GameSnapshot,
  GameStartOptions,
  NetworkWorldSnapshot,
  MiniMapSnapshot,
  PartyMemberSnapshot,
  Phase,
  RoomMapCell,
  TeamStats,
  UpgradeId,
} from "../../domain/types";
import { NIGHT_ATTACK_RANGE_MULTIPLIER, NIGHT_PLAYER_VISION_RADIUS, PLAYER_VISION_RADIUS, transformFlags, type CombatActionEvent, type InputFrame, type WorldFrame } from "@five-days/protocol";
import { resolveSharedPartyProgress } from "../../domain/sharedPartyProgress";
import { editorThemeZone, type EditorConnection } from "../../domain/mapEditor";
import { buildEditorCoreWorld, editorCoreRoomId } from "@/src/features/map-editor/editorCoreWorld";
import { localCoreSession } from "@/src/features/map-editor/LocalCoreSession";
import { ProgressionModel } from "../../systems/ProgressionModel";
import { HERO_SPRITE_FRAME_SIZE, HERO_SPRITE_PATHS, HERO_TOTAL_FRAME_COUNT } from "../../client/render/heroSprites";
import { BASIC_ATTACK_SPRITES } from "../../client/render/attackEffectSprites";
import { COMBAT_SOUND_PATHS } from "../../client/audio/combatSounds";
import { colyseusTransport } from "../../transport/ColyseusTransport";
import { areAuthoredBossGatesCleared, predictPlayerTransform, RealtimeTransformBuffer, shouldRenderPartyMember } from "../../netcode/RealtimeBuffer";
import { aimAngleBetween } from "../../netcode/aim";
import { gameBridge, type GameCommand } from "../GameBridge";
import {
  BASE_CORE,
  buildEditorRenderWorld,
  buildRenderWorld,
  clipWalkableLine,
  clampToWalkable,
  clampToWorld,
  isInsideBuildBounds,
  snapToBuildGrid,
  type RenderableRoom,
  type RenderWorldRoom,
  type RenderZoneWorld,
} from "./layout";
import { PlayerVisionFog } from "./PlayerVisionFog";
import { RoomRenderer } from "./RoomRenderer";
import type { VisionRevealSource } from "./vision";

type LocalEnemyKind = "static" | "hidden" | "gate" | "invader" | "boss";
const PLAYER_COLLISION_RADIUS = ACTOR_COLLISION_RADIUS;
const ENEMY_COLLISION_RADIUS = 12;
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

type LocalEnemy = {
  id: string;
  kind: LocalEnemyKind;
  sprite: Phaser.Physics.Arcade.Sprite;
  hpBar?: Phaser.GameObjects.Graphics;
  hp: number;
  maxHp: number;
  damage: number;
  speed: number;
  rewardXp: number;
  rewardGold: number;
  engaged: boolean;
  spawnX: number;
  spawnY: number;
  lastAttackAt: number;
  lastShotAt: number;
  patternIndex: number;
  patternActive: boolean;
};

type LocalStructure = {
  id: string;
  kind: "turret" | "wall";
  sprite: Phaser.Physics.Arcade.Image;
  level: number;
  hp: number;
  nextShotAt: number;
};

type LocalDrop = {
  item: PersonalHiddenDrop;
  object: Phaser.GameObjects.Container;
};

type EquippedRuntime = {
  summary: EquipmentSummary;
  item: PersonalHiddenDrop;
  attackBonus: number;
  hpBonus: number;
  defenseBonus: number;
  attackSpeedPercent: number;
};

type LocalMapRoom = {
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

const SESSION_DURATIONS = {
  prototype: { day: 60, night: 25, standby: 5 },
  full: { day: 210, night: 75, standby: 15 },
} as const;

const WAYPOINT_HOLD_SECONDS = 5;
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
  private readonly classDefinition;
  private readonly difficulty;
  private readonly runSeed: string;
  private readonly worldMap: ThreeZoneMap;
  private readonly editorRooms: readonly LocalMapRoom[];
  private readonly authoredConnections: readonly EditorConnection[];
  private readonly progressionWorld: CoreWorldDefinition | null;
  private readonly progression: ProgressionModel;
  private roomRenderer!: RoomRenderer;
  private player!: Phaser.Physics.Arcade.Sprite;
  private visionFog!: PlayerVisionFog;
  private deathOverlay!: Phaser.GameObjects.Rectangle;
  private deathOverlayText!: Phaser.GameObjects.Text;
  private deathPresentationActive = false;
  private localRespawnAt: number | null = null;
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
  private enemies: LocalEnemy[] = [];
  private lastWalkablePlayerPosition: { x: number; y: number } | null = null;
  private readonly lastWalkableEnemyPositions = new Map<string, { x: number; y: number }>();
  private drops: LocalDrop[] = [];
  private structures: LocalStructure[] = [];
  private readonly remotePlayers = new Map<string, Phaser.Physics.Arcade.Sprite>();
  private readonly networkEnemies = new Map<string, Phaser.GameObjects.Sprite>();
  private readonly networkEnemyKinds = new Map<string, LocalEnemyKind>();
  private readonly pendingNetworkEnemyIds: string[] = [];
  private readonly pendingNetworkEnemySet = new Set<string>();
  private readonly networkEnemyHp = new Map<string, number>();
  private networkEnemyHpLayer!: Phaser.GameObjects.Graphics;
  private lastNetworkHpDrawAt = 0;
  private readonly networkEnemyAttackSequence = new Map<string, number>();
  private readonly networkPlayerAttackSequence = new Map<string, number>();
  private readonly networkPlayerSkillSequence = new Map<string, number>();
  private readonly networkDrops = new Map<string, Phaser.GameObjects.Container>();
  private readonly networkDropRequests = new Map<string, number>();
  private readonly visitedRooms = new Set<string>();
  private readonly clearedRooms = new Set<string>();
  private readonly unlockedResources = new Set<string>();
  private readonly clearedGateZones = new Set<number>();
  private readonly staticRespawnAt = new Map<string, number>();
  private readonly equipment = new Map<EquipmentSummary["slot"], EquippedRuntime>();
  private readonly localMiniMaps = new Map<string, MiniMapSnapshot>();
  private currentZone: ZoneId = 1;
  private currentRoomId: string;
  private zoneWorld!: RenderZoneWorld;
  private authoredRenderWorld?: RenderZoneWorld;
  private renderedWaypointKey = "";
  private localPhase: Phase = "day";
  private currentVisionRadius = PLAYER_VISION_RADIUS;
  private localDay = 1;
  private phaseRemaining: number;
  private elapsed = 0;
  private baseHp = BASE_MAX_HP;
  private gold = 100;
  private buildMode: BuildMode = null;
  private lastAutoAttackAt = 0;
  private qReadyAt = 0;
  private eReadyAt = 0;
  private dashReadyAt = 0;
  private snapshotAccumulator = 0;
  private passiveGoldAccumulator = 0;
  private nightDamageAccumulator = 0;
  private waypointAction: "advance" | "recall" | null = null;
  private travelProgress = 0;
  private awaitingUpgrade = false;
  private draftIndex = 0;
  private currentDraftIds = new Set<UpgradeId>();
  private attackCounter = 0;
  private lastLocalAttackCritical = false;
  private lastLocalTargetId: string | null = null;
  private consecutiveLocalHits = 0;
  private readonly localVulnerableUntil = new Map<string, number>();
  private readonly localMarkedUntil = new Map<string, number>();
  private ended = false;
  private message = "연결된 문을 따라 첫 구역을 탐색하세요.";
  private latestNetwork: NetworkWorldSnapshot | null = null;
  private readonly transformBuffer = new RealtimeTransformBuffer();
  private localPrediction: { x: number; y: number; roomId: string } | null = null;
  private localCorrection: { x: number; y: number; startedAt: number } | null = null;
  private renderedNetworkRoomKey = "";
  private renderedNetworkDraftId: string | null | undefined;
  private boss: LocalEnemy | null = null;
  private bossFireTrails: Array<{
    x: number;
    y: number;
    expiresAt: number;
    graphics: Phaser.GameObjects.Graphics;
    lastDamageAt: number;
  }> = [];
  private dragonFireballs: Array<{
    x: number;
    y: number;
    vx: number;
    vy: number;
    createdAt: number;
    graphics: Phaser.GameObjects.Graphics;
  }> = [];
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
    this.classDefinition = CLASS_DEFINITIONS[options.heroClass];
    this.difficulty = DIFFICULTY[options.difficulty];
    this.runSeed = `v02:${options.userId ?? "local"}:${options.heroClass}:${options.difficulty}`;
    this.worldMap = generateThreeZoneMap(this.runSeed);
    const editorCore = options.runtimeMode === "editor-core";
    const authoredMap = options.editorMap ?? (options.networked ? OFFICIAL_MAP_MANIFEST.map : null);
    this.progressionWorld = options.editorMap
      ? buildEditorCoreWorld(options.editorMap)
      : options.networked ? OFFICIAL_MAP_MANIFEST.world : null;
    const prefixAuthoredIds = editorCore || Boolean(options.networked);
    this.authoredConnections = authoredMap ? authoredMap.connections.map((connection) => ({
      ...connection,
      fromPort: connection.fromPort ? { ...connection.fromPort } : undefined,
      toPort: connection.toPort ? { ...connection.toPort } : undefined,
    })) : [];
    this.editorRooms = authoredMap ? authoredMap.rooms.map((room): LocalMapRoom => ({
      id: prefixAuthoredIds ? editorCoreRoomId(room.id) : room.id,
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
          return prefixAuthoredIds ? editorCoreRoomId(connectedId) : connectedId;
        }),
      depthScore: room.x + room.y,
    })) : [];
    this.currentRoomId = this.editorRooms.find((room) => room.type === "start")?.id ?? this.worldMap.zones[0].startRoomId;
    this.phaseRemaining = SESSION_DURATIONS[options.sessionMode].day;
    this.progression = new ProgressionModel({
      ...this.classDefinition.stats,
      hp: this.classDefinition.stats.maxHp,
    });
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
    for (const sprite of Object.values(BASIC_ATTACK_SPRITES)) {
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

  }

  create(): void {
    this.renderZoneWorld(this.currentZone);
    this.roomRenderer = new RoomRenderer(this);
    gameBridge.emit("loading", { progress: 0.82, label: "렌더러 준비 중" });
    this.roomRenderer.create();
    const initialSnapshot = this.usesAuthoritativeRuntime()
      ? this.options.runtimeMode === "editor-core" && this.options.editorMap
        ? localCoreSession.start(buildEditorCoreWorld(this.options.editorMap), this.options.userId ?? "map-editor")
        : colyseusTransport.snapshot
      : null;
    const initialLocalRoom = !this.usesAuthoritativeRuntime()
      ? this.allLocalRooms().find((room) => room.id === this.currentRoomId)
      : undefined;
    const initialLocalWaypointActive = initialLocalRoom?.type === "start" || initialLocalRoom?.type === "central-waypoint";
    const initialWaypointRooms = initialSnapshot
      ? this.activeWaypointRooms(initialSnapshot)
      : initialLocalWaypointActive ? new Set([this.currentRoomId]) : new Set<string>();
    this.renderedNetworkRoomKey = initialSnapshot ? this.waypointRenderKey(initialSnapshot) : "";
    if (initialLocalRoom) {
      this.renderedWaypointKey = `${this.options.editorMap ? "editor" : initialLocalRoom.zone}:${initialLocalWaypointActive ? initialLocalRoom.id : ""}`;
    }
    gameBridge.emit("loading", { progress: 0.87, label: "월드 구성 중" });
    this.roomRenderer.renderWorld(this.zoneWorld, {
      decorSeed: this.runSeed,
      showBuildGrid: this.currentZone === 1,
      waypointRooms: initialWaypointRooms,
    });
    this.networkEnemyHpLayer = this.add.graphics().setDepth(28);
    const startCenter = this.zoneWorld.rooms.find((entry) => entry.room.id === this.currentRoomId)?.center ?? { x: 0, y: 0 };
    this.player = this.roomRenderer.createHero(this.options.heroClass, startCenter.x, startCenter.y);
    this.lastWalkablePlayerPosition = { ...startCenter };
    this.player.setVisible(!this.usesAuthoritativeRuntime());
    this.configureCamera();
    this.createDeathOverlay();
    this.visionFog = new PlayerVisionFog(this);
    this.configureVisionWorld();
    this.configureInput();
    this.commandDisconnect = gameBridge.connect((command) => this.handleCommand(command));

    if (this.usesAuthoritativeRuntime()) {
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
    } else {
      this.enterLocalRoom(this.currentRoomId, null, true);
      if (this.options.targetRoomType === "boss") {
        this.time.delayedCall(80, () => this.enterBossRoom());
      } else if (this.options.targetRoomType === "hidden") {
        const hiddenRoom = this.allLocalRooms().find((r) => r.type === "hidden-monster");
        if (hiddenRoom) {
          this.time.delayedCall(80, () => this.enterLocalRoom(hiddenRoom.id, null));
        }
      }
    }

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
    if (this.editorRooms.length > 0) {
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
      const sourceConnections = this.authoredConnections.map((connection) => this.options.runtimeMode === "editor-core" || this.options.networked
        ? { ...connection, from: editorCoreRoomId(connection.from), to: editorCoreRoomId(connection.to) }
        : connection);
      this.authoredRenderWorld ??= buildEditorRenderWorld(rooms, sourceConnections);
      this.zoneWorld = this.authoredRenderWorld;
      this.physics.world.setBounds(this.zoneWorld.bounds.x, this.zoneWorld.bounds.y, this.zoneWorld.bounds.width, this.zoneWorld.bounds.height);
      this.cameras.main?.setBounds(this.zoneWorld.bounds.x, this.zoneWorld.bounds.y, this.zoneWorld.bounds.width, this.zoneWorld.bounds.height);
      this.roomRenderer?.renderWorld(this.zoneWorld, {
        decorSeed: `${this.runSeed}:editor`,
        showBuildGrid: true,
        waypointRooms: waypointRoomId ? new Set([waypointRoomId]) : new Set(),
      });
      this.configureVisionWorld();
      return;
    }
    const zoneMap = this.worldMap.zones[zone - 1];
    const rooms = zoneMap.rooms.map((room): RenderableRoom => ({
      id: room.id,
      zone: room.zone,
      x: room.x,
      y: room.y,
      type: room.type,
      connections: [...room.connections],
    }));
    this.zoneWorld = buildRenderWorld(rooms, zone === 3);
    this.physics.world.setBounds(0, 0, this.zoneWorld.bounds.width, this.zoneWorld.bounds.height);
    this.cameras.main?.setBounds(0, 0, this.zoneWorld.bounds.width, this.zoneWorld.bounds.height);
    this.roomRenderer?.renderWorld(this.zoneWorld, {
      decorSeed: this.runSeed,
      showBuildGrid: zone === 1,
      waypointRooms: waypointRoomId ? new Set([waypointRoomId]) : new Set(),
    });
    this.configureVisionWorld();
  }

  update(time: number, delta: number): void {
    const safeDeltaMs = Math.min(100, Math.max(0, delta));
    this.roomRenderer.updateCrosshair(this.input.activePointer);
    const targetVisionRadius = this.localPhase === "night" ? NIGHT_PLAYER_VISION_RADIUS : PLAYER_VISION_RADIUS;
    const visionStep = VISION_RADIUS_CHANGE_PER_SECOND * safeDeltaMs / 1_000;
    if (this.currentVisionRadius < targetVisionRadius) this.currentVisionRadius = Math.min(targetVisionRadius, this.currentVisionRadius + visionStep);
    else if (this.currentVisionRadius > targetVisionRadius) this.currentVisionRadius = Math.max(targetVisionRadius, this.currentVisionRadius - visionStep);
    this.visionFog.update(
      this.player.x,
      this.player.y,
      Math.round(this.currentVisionRadius / 4) * 4,
    );
    if (this.ended) return;

    if (this.usesAuthoritativeRuntime()) {
      if (this.options.runtimeMode === "editor-core") {
        const aim = this.aimAngle();
        const input = {
          x: Number(this.keys.D?.isDown) - Number(this.keys.A?.isDown),
          y: Number(this.keys.S?.isDown) - Number(this.keys.W?.isDown),
          aim,
          buttons: Number(this.keys.SPACE?.isDown) << 2,
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
      const aim = this.aimAngle();
      if (this.options.runtimeMode !== "editor-core") colyseusTransport.setAim(aim);
      this.roomRenderer.updateHeroPose(this.player, this.localMovementX, this.localMovementY, time);
      this.snapshotAccumulator += safeDeltaMs;
      if (this.snapshotAccumulator >= 120) {
        this.snapshotAccumulator = 0;
        this.emitSnapshot();
      }
      return;
    }

    if (this.localRespawnAt !== null) {
      const remaining = Math.max(0, (this.localRespawnAt - time) / 1_000);
      this.updateDeathPresentation(false, remaining);
      this.player.setVelocity(0);
      this.snapshotAccumulator += safeDeltaMs;
      if (this.snapshotAccumulator >= 120) {
        this.snapshotAccumulator = 0;
        this.emitSnapshot();
      }
      return;
    }

    this.updateLocalSession(safeDeltaMs / 1000);
    this.updateLocalPlayer(time);
    this.updateAutoAttack(time);
    this.updateEnemies(time);
    this.updateStructures(time);
    this.updateDrops();
    this.updateStaticRespawn(time);
    this.updatePassiveGold(safeDeltaMs);
    this.updateTravel(safeDeltaMs / 1000);

    this.snapshotAccumulator += safeDeltaMs;
    if (this.snapshotAccumulator >= 120) {
      this.snapshotAccumulator = 0;
      this.emitSnapshot();
    }
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

  /** Server snapshots are the only simulation source while networked. */
  public syncNetworkState(snapshot: NetworkWorldSnapshot): void {
    if (!this.usesAuthoritativeRuntime() || this.ended) return;
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
    this.syncNetworkPlayers(snapshot, local);
    this.roomRenderer.updateProgressionBarriers(this.lockedProgressionBarriers(snapshot));
    this.syncNetworkEnemies(snapshot, local);
    this.syncNetworkDrops(snapshot, local.roomId);
    this.emitSnapshot();
  }

  private handleWorldFrame(frame: WorldFrame): void {
    if (!this.usesAuthoritativeRuntime() || this.ended) return;
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
    const bossAccessible = areAuthoredBossGatesCleared(
      snapshot.day,
      OFFICIAL_MAP_MANIFEST.world.gateRoomIds,
      snapshot.rooms,
    );
    const currentZoneGateIds = OFFICIAL_MAP_MANIFEST.world.gateRoomIds.filter((gateRoomId) => (
      OFFICIAL_MAP_MANIFEST.world.rooms.some((room) => room.id === gateRoomId && room.zone === snapshot.currentZone)
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
      this.player.setVisible(true).setActive(true);
      this.roomRenderer.updateHeroPose(this.player, this.localMovementX, this.localMovementY, poseTime);
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
    }
    this.drawNetworkEnemyHpBars(snapshot, localState, now);
  }

  private configureInput(): void {
    if (!this.input.keyboard) return;
    this.keys = this.input.keyboard.addKeys("W,A,S,D,Q,E,SPACE,B") as typeof this.keys;
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (!this.usesAuthoritativeRuntime() && this.buildMode) this.tryBuildAt(pointer.worldX, pointer.worldY);
    });
  }

  private enterLocalRoom(roomId: string, sourceRoomId: string | null, keepPosition = false): void {
    this.clearTransientEntities();
    const room = this.allLocalRooms().find((candidate) => candidate.id === roomId);
    if (!room) throw new Error(`Unknown local room: ${roomId}`);
    this.currentRoomId = room.id;
    this.currentZone = room.zone;
    this.visitedRooms.add(room.id);

    if (room.type === "boss") this.localPhase = "boss";
    const waypointActive = room.type === "start"
      || room.type === "central-waypoint"
      || (!this.options.editorMap && room.type === "gate" && this.clearedGateZones.has(room.zone));
    const waypointKey = `${this.options.editorMap ? "editor" : room.zone}:${waypointActive ? room.id : ""}`;
    if (waypointKey !== this.renderedWaypointKey) {
      this.renderedWaypointKey = waypointKey;
      if (this.editorRooms.length > 0) {
        this.roomRenderer.updateWaypoints(this.zoneWorld, waypointActive ? new Set([room.id]) : new Set());
      } else {
        this.renderZoneWorld(room.zone, waypointActive ? room.id : undefined);
      }
    }

    if (!keepPosition) {
      const center = this.zoneWorld.rooms.find((entry) => entry.room.id === room.id)?.center
        ?? { x: 0, y: 0 };
      this.setLocalPlayerPosition(center.x, center.y);
    }
    this.player.setVisible(true).setActive(true).setVelocity(0);

    this.updateStructureVisibility();
    if (room.type === "resource" && !this.unlockedResources.has(room.id)) {
      this.unlockedResources.add(room.id);
      this.gold += 15;
      this.message = `자원 방 해금 · 발견한 방마다 5초에 1G, 현재 ${this.unlockedResources.size}G를 생산합니다.`;
    }
    const staticRespawnDue = room.type === "static-monster" && (this.staticRespawnAt.get(room.id) ?? Number.POSITIVE_INFINITY) <= this.time.now;
    if (staticRespawnDue) {
      this.staticRespawnAt.delete(room.id);
      this.clearedRooms.delete(room.id);
    }
    if (!this.clearedRooms.has(room.id)) this.spawnRoomContent(room);
    else if (room.type !== "gate") this.message = "정복한 방입니다. 연결된 통로로 이동할 수 있습니다.";
  }

  private spawnRoomContent(room: LocalMapRoom): void {
    const entry = this.zoneWorld.rooms.find((candidate) => candidate.room.id === room.id);
    const cx = entry?.center.x ?? 0;
    const cy = entry?.center.y ?? 0;
    if (room.type === "static-monster") {
      const count = 2 + room.zone;
      for (let index = 0; index < count; index += 1) {
        const angle = (Math.PI * 2 * index) / count;
        this.spawnEnemy("static", cx + Math.cos(angle) * 155, cy + Math.sin(angle) * 115, room.zone);
      }
      this.message = "정적 몬스터는 먼저 공격하기 전까지 움직이지 않습니다.";
    } else if (room.type === "hidden-monster") {
      this.spawnEnemy("hidden", cx, cy - 30, room.zone);
      this.message = "숨겨진 수호자 · 강력한 원거리 공격을 경계하세요.";
    } else if (room.type === "gate") {
      this.spawnEnemy("gate", cx, cy - 30, room.zone);
      this.message = `구역 ${room.zone} 게이트를 파괴하면 웨이포인트가 활성화됩니다.`;
    } else if (room.type === "boss") {
      this.spawnEnemy("boss", cx, cy, room.zone);
      this.message = "마왕의 제단 · 보스를 쓰러뜨려 편집 맵을 검증하세요.";
    } else {
      this.clearedRooms.add(room.id);
    }
  }

  private spawnEnemy(kind: LocalEnemyKind, x: number, y: number, zone: number): LocalEnemy {
    const zoneScale = 1 + (zone - 1) * 0.3;
    const base = kind === "hidden"
      ? { hp: 145, damage: 14, speed: 68, xp: 38, gold: 24 }
      : kind === "gate"
        ? { hp: 190, damage: 18, speed: 0, xp: 32, gold: 30 }
        : kind === "boss"
          ? { hp: 950, damage: 28, speed: 0, xp: 0, gold: 0 }
          : kind === "invader"
            ? { hp: 28, damage: 9, speed: 92, xp: 7, gold: 5 }
            : { hp: 24, damage: 8, speed: 78, xp: 8, gold: 6 };
    const maxHp = Math.round(base.hp * zoneScale * this.difficulty.enemyHp);
    const enemy: LocalEnemy = {
      id: `${this.currentRoomId}:${kind}:${this.attackCounter++}`,
      kind,
      sprite: this.roomRenderer.createEnemy(kind, x, y),
      hpBar: this.add.graphics().setDepth(28),
      hp: maxHp,
      maxHp,
      damage: Math.round(base.damage * zoneScale * this.difficulty.enemyDamage),
      speed: base.speed * this.difficulty.enemySpeed,
      rewardXp: base.xp,
      rewardGold: Math.round(base.gold * this.difficulty.reward),
      engaged: kind === "invader" || kind === "boss",
      spawnX: x,
      spawnY: y,
      lastAttackAt: 0,
      lastShotAt: 0,
      patternIndex: 0,
      patternActive: false,
    };
    this.updateLocalEnemyHpBar(enemy);
    this.enemies.push(enemy);
    this.lastWalkableEnemyPositions.set(enemy.id, { x, y });
    if (kind === "boss") this.boss = enemy;
    return enemy;
  }

  private drawMonsterHpBar(
    graphics: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    hp: number,
    maxHp: number,
    kind: LocalEnemyKind,
  ): void {
    graphics.clear().setPosition(x, y);
    if (hp <= 0 || maxHp <= 0) return;

    const isBoss = kind === "boss";
    const isMidboss = kind === "hidden";
    const isElite = kind === "gate" || isMidboss;
    const width = isBoss ? 72 : isMidboss ? 52 : isElite ? 38 : 28;
    const height = isBoss ? 7 : isMidboss ? 5 : 4;
    const offsetY = isBoss ? 125 : isMidboss ? 92 : isElite ? 26 : 20;
    const barX = -width / 2;
    const barY = -offsetY;

    const hpRatio = Math.max(0, Math.min(1, hp / maxHp));

    graphics.fillStyle(0x0a0d0e, 0.85);
    graphics.fillRect(barX - 1, barY - 1, width + 2, height + 2);

    graphics.fillStyle(0x380b0b, 0.95);
    graphics.fillRect(barX, barY, width, height);

    let fillColor = 0x2cd467;
    if (isBoss) {
      fillColor = hpRatio > 0.5 ? 0xffb700 : hpRatio > 0.25 ? 0xff6600 : 0xe62e2e;
    } else if (hpRatio <= 0.25) {
      fillColor = 0xeb3b3b;
    } else if (hpRatio <= 0.5) {
      fillColor = 0xf5b942;
    }

    graphics.fillStyle(fillColor, 1);
    graphics.fillRect(barX, barY, Math.max(1, width * hpRatio), height);

    graphics.fillStyle(0xffffff, 0.35);
    graphics.fillRect(barX, barY, Math.max(1, width * hpRatio), 1);
  }

  private updateLocalEnemyHpBar(enemy: LocalEnemy): void {
    if (!enemy.hpBar) return;
    if (!enemy.sprite.active || enemy.hp <= 0 || enemy.sprite.getData("isEmerging")) {
      enemy.hpBar.clear();
      return;
    }
    this.drawMonsterHpBar(enemy.hpBar, enemy.sprite.x, enemy.sprite.y, enemy.hp, enemy.maxHp, enemy.kind);
  }

  private updateLocalPlayer(time: number): void {
    if (!this.player.active) return;
    const anchor = this.lastWalkablePlayerPosition ?? { x: this.player.x, y: this.player.y };
    const clamped = clampToWalkable(this.zoneWorld.walkable, this.player.x, this.player.y, anchor.x, anchor.y, PLAYER_COLLISION_RADIUS);
    this.setLocalPlayerPosition(clamped.x, clamped.y);
    const x = Number(this.keys.D?.isDown) - Number(this.keys.A?.isDown);
    const y = Number(this.keys.S?.isDown) - Number(this.keys.W?.isDown);
    const movement = new Phaser.Math.Vector2(x, y).normalize().scale(this.progression.stats.moveSpeed);
    this.player.setVelocity(movement.x, movement.y);
    const aim = this.aimAngle();
    this.roomRenderer.updateHeroPose(this.player, x, y, time);

    this.updateAutoSkills(time);
    if (Phaser.Input.Keyboard.JustDown(this.keys.SPACE) && time >= this.dashReadyAt) this.useDash(aim);
    if (Phaser.Input.Keyboard.JustDown(this.keys.B) && this.localPhase !== "boss") this.requestWaypointAction("recall");

    if (!this.isLocalBuildRoom() || !isInsideBuildBounds(this.player.x, this.player.y)) this.buildMode = null;
    this.updateLocalRoomPresence();
  }

  /**
   * Seamless room transition: when the player walks into a new room's world
   * rectangle (possibly through a connecting corridor), enter that room without
   * repositioning, so movement feels continuous.
   */
  private updateLocalRoomPresence(): void {
    if (this.currentRoomId === "boss" || this.ended) return;
    const entry = this.worldRoomAtPoint(this.player.x, this.player.y);
    if (entry && entry.room.id !== this.currentRoomId) {
      this.enterLocalRoom(entry.room.id, this.currentRoomId, true);
    }
  }

  private worldRoomAtPoint(x: number, y: number): RenderWorldRoom | undefined {
    return this.zoneWorld.rooms.find((candidate) => {
      const { x: left, y: top, width, height } = candidate.rect;
      return x >= left && x < left + width && y >= top && y < top + height;
    });
  }

  private updateAutoAttack(time: number): void {
    const interval = this.effectiveAttackInterval();
    if (time < this.lastAutoAttackAt) return;
    const aim = this.aimAngle();
    const attackRange = this.effectiveAttackRange();
    const targets = this.findAimConeTargets(attackRange, aim);
    if (targets.length === 0) return;
    const projectileCount = Math.max(1,
      this.progression.stats.projectileCount
      + (this.progression.has("archer-volley") ? 1 : 0)
      + (this.progression.has("archer-piercing") ? 2 : 0)
      + (this.progression.has("archer-ricochet") ? 1 : 0)
      + (this.progression.has("mage-chain") ? 1 : 0));
    const selected = targets.slice(0, this.classDefinition.attackKind === "melee" ? 1 : projectileCount);
    this.attackCounter += 1;
    if (this.lastLocalTargetId === selected[0]?.id) this.consecutiveLocalHits += 1;
    else {
      this.lastLocalTargetId = selected[0]?.id ?? null;
      this.consecutiveLocalHits = 1;
    }
    for (const target of selected) {
      const attack = this.rollAttackDamage(target);
      this.lastLocalAttackCritical = attack.critical;
      this.roomRenderer.showClassAttack(this.options.heroClass, this.player, target.sprite.x, target.sprite.y, aim, attack.critical);
      this.damageEnemy(target, attack.damage);
    }
    this.lastAutoAttackAt = time + interval;
  }

  private findAimConeTargets(range: number, aimAngle: number): LocalEnemy[] {
    return this.enemies
      .filter((enemy) => enemy.sprite.active)
      .map((enemy) => ({
        enemy,
        distance: Phaser.Math.Distance.Between(this.player.x, this.player.y, enemy.sprite.x, enemy.sprite.y),
        angle: Phaser.Math.Angle.Between(this.player.x, this.player.y, enemy.sprite.x, enemy.sprite.y),
      }))
      .filter(({ distance, angle }) => distance <= range && Math.abs(Phaser.Math.Angle.Wrap(angle - aimAngle)) <= this.aimConeHalfAngle())
      .filter(({ enemy }) => this.hasLineOfSight(this.player.x, this.player.y, enemy.sprite.x, enemy.sprite.y))
      .sort((left, right) => left.distance - right.distance || left.enemy.id.localeCompare(right.enemy.id))
      .map(({ enemy }) => enemy);
  }

  private rollAttackDamage(target: LocalEnemy): { damage: number; critical: boolean } {
    let damage = this.effectiveAttack();
    const precision = (this.progression.stacks.get("precision") ?? 0) * 0.03;
    const critical = createSeededRandom(`${this.runSeed}:attack:${this.attackCounter}`).next() < precision;
    if (critical) damage *= 1.5 + (this.progression.stacks.get("ferocity") ?? 0) * 0.1;
    if (["hidden", "gate", "boss"].includes(target.kind)) damage *= 1 + (this.progression.stacks.get("boss-hunter") ?? 0) * 0.06;
    if (this.progression.has("swordsman-execution") && target.hp / target.maxHp <= 0.3) damage *= 1.3;
    if (this.progression.has("archer-sniper")) {
      const distance = Phaser.Math.Distance.Between(this.player.x, this.player.y, target.sprite.x, target.sprite.y);
      damage *= 1 + Math.min(0.275, Math.max(0, distance - 180) / 510);
    }
    const momentum = this.progression.stacks.get("momentum") ?? 0;
    if (momentum > 0) damage *= 1 + Math.min(0.1 * momentum, this.consecutiveLocalHits * 0.02 * momentum);
    if (this.progression.has("swordsman-combo") && this.attackCounter % 3 === 0) damage *= 1.5;
    if (this.progression.has("mage-overcharge") && this.attackCounter % 4 === 0) damage *= 1.6;
    if ((this.localVulnerableUntil.get(target.id) ?? 0) > this.time.now) damage *= 1.075;
    if ((this.localMarkedUntil.get(target.id) ?? 0) > this.time.now) damage *= 1.125;
    return { damage: Math.max(1, Math.round(damage)), critical };
  }

  private updateAutoSkills(time: number): void {
    for (const skill of ["q", "e"] as const) {
      const readyAt = skill === "q" ? this.qReadyAt : this.eReadyAt;
      if (time < readyAt) continue;
      const definition = autoSkillDefinition(this.options.heroClass, skill);
      const target = this.findAutoSkillTarget(definition);
      if (!target) continue;
      this.useSkill(skill, Phaser.Math.Angle.Between(this.player.x, this.player.y, target.sprite.x, target.sprite.y), target);
    }
  }

  private findAutoSkillTarget(definition: ReturnType<typeof autoSkillDefinition>): LocalEnemy | null {
    const candidates = this.enemies.filter((enemy) => enemy.sprite.active
      && Phaser.Math.Distance.Between(this.player.x, this.player.y, enemy.sprite.x, enemy.sprite.y) <= definition.range
      && this.hasLineOfSight(this.player.x, this.player.y, enemy.sprite.x, enemy.sprite.y));
    const clusterScore = (anchor: LocalEnemy) => candidates.filter((enemy) => (
      Phaser.Math.Distance.Between(anchor.sprite.x, anchor.sprite.y, enemy.sprite.x, enemy.sprite.y) <= definition.radius
    )).length;
    return candidates.sort((left, right) => {
      const leftDistance = Phaser.Math.Distance.Between(this.player.x, this.player.y, left.sprite.x, left.sprite.y);
      const rightDistance = Phaser.Math.Distance.Between(this.player.x, this.player.y, right.sprite.x, right.sprite.y);
      return definition.targeting === "area"
        ? clusterScore(right) - clusterScore(left) || leftDistance - rightDistance
        : leftDistance - rightDistance || left.id.localeCompare(right.id);
    })[0] ?? null;
  }

  private useSkill(skill: "q" | "e", aim: number, anchor: LocalEnemy): void {
    const definition = autoSkillDefinition(this.options.heroClass, skill);
    const cooldownReduction = Math.min(0.6, (this.progression.stacks.get("skill-haste") ?? 0) * 0.03 + (this.progression.has("mage-tempo") ? 0.125 : 0));
    if (skill === "q") this.qReadyAt = this.time.now + definition.cooldownSeconds * 1_000 * (1 - cooldownReduction);
    else this.eReadyAt = this.time.now + definition.cooldownSeconds * 1_000 * (1 - cooldownReduction);
    const damage = Math.round(this.effectiveAttack() * definition.damageMultiplier * this.progression.stats.skillPower);
    const areaMultiplier = 1 + (this.progression.stacks.get("area-power") ?? 0) * 0.06 + (this.progression.has("mage-nova") ? 0.275 : 0);
    const targetX = anchor.sprite.x;
    const targetY = anchor.sprite.y;
    const radius = definition.radius * areaMultiplier;
    if (definition.dashDistance) {
      const point = clampToWalkable(this.zoneWorld.walkable, this.player.x + Math.cos(aim) * definition.dashDistance, this.player.y + Math.sin(aim) * definition.dashDistance, this.player.x, this.player.y, PLAYER_COLLISION_RADIUS);
      this.setLocalPlayerPosition(point.x, point.y);
    }
    const targets = this.enemies.filter((enemy) => enemy.sprite.active && this.hasLineOfSight(this.player.x, this.player.y, enemy.sprite.x, enemy.sprite.y)).filter((enemy) => {
      if (definition.targeting === "single") return enemy.id === anchor.id;
      if (definition.targeting === "area") return Phaser.Math.Distance.Between(targetX, targetY, enemy.sprite.x, enemy.sprite.y) <= radius;
      const along = (enemy.sprite.x - this.player.x) * Math.cos(aim) + (enemy.sprite.y - this.player.y) * Math.sin(aim);
      const across = Math.abs((enemy.sprite.x - this.player.x) * Math.sin(aim) - (enemy.sprite.y - this.player.y) * Math.cos(aim));
      return along >= 0 && along <= definition.range * areaMultiplier && across <= radius;
    }).slice(0, definition.maxTargets);
    for (const enemy of targets) {
      this.damageEnemy(enemy, damage);
      if (this.progression.has("swordsman-rupture")) this.localVulnerableUntil.set(enemy.id, this.time.now + 3_000);
      if (this.progression.has("archer-mark")) this.localMarkedUntil.set(enemy.id, this.time.now + 5_000);
      if (this.progression.has("mage-echo") && enemy.sprite.active) this.damageEnemy(enemy, damage * 0.275);
    }
    this.roomRenderer.showAutoSkill(this.options.heroClass, skill, this.player, targetX, targetY, radius);
  }

  private useDash(aim: number): void {
    this.dashReadyAt = this.time.now + 5000;
    const body = this.player.body as Phaser.Physics.Arcade.Body;
    const start = this.lastWalkablePlayerPosition ?? { x: this.player.x, y: this.player.y };
    const direction = new Phaser.Math.Vector2(body.velocity.x, body.velocity.y);
    if (direction.lengthSq() < 1) direction.setToPolar(aim, 1);
    direction.normalize().scale(145);
    const point = clampToWalkable(
      this.zoneWorld.walkable,
      start.x + direction.x,
      start.y + direction.y,
      start.x,
      start.y,
      PLAYER_COLLISION_RADIUS,
    );
    this.roomRenderer.showDodge(this.player, point.x, point.y);
    this.setLocalPlayerPosition(point.x, point.y);
    this.player.setAlpha(0.35);
    this.time.delayedCall(220, () => this.player.active && this.player.setAlpha(1));
  }

  private updateEnemies(time: number): void {
    for (const enemy of this.enemies) {
      if (!enemy.sprite.active) continue;
      const anchor = this.lastWalkableEnemyPositions.get(enemy.id)
        ?? { x: enemy.sprite.x, y: enemy.sprite.y };
      if (enemy.kind === "gate" || enemy.kind === "boss") enemy.sprite.setVelocity(0);
      const playerDistance = Phaser.Math.Distance.Between(enemy.sprite.x, enemy.sprite.y, this.player.x, this.player.y);
      if (enemy.kind === "static") {
        enemy.engaged = playerDistance <= 560;
        if (!enemy.engaged) this.physics.moveTo(enemy.sprite, enemy.spawnX, enemy.spawnY, enemy.speed);
        else if (playerDistance > 34) this.physics.moveTo(enemy.sprite, this.player.x, this.player.y, enemy.speed);
        else {
          enemy.sprite.setVelocity(0);
          if (this.hasLineOfSight(enemy.sprite.x, enemy.sprite.y, this.player.x, this.player.y) && time - enemy.lastAttackAt >= 900) {
            enemy.lastAttackAt = time;
            this.roomRenderer.showEnemyMeleeAttack(enemy.sprite, this.player.x, this.player.y);
            this.damagePlayer(enemy.damage);
          }
        }
        const clamped = clampToWalkable(this.zoneWorld.walkable, enemy.sprite.x, enemy.sprite.y, anchor.x, anchor.y, ENEMY_COLLISION_RADIUS);
        enemy.sprite.setPosition(clamped.x, clamped.y);
        this.lastWalkableEnemyPositions.set(enemy.id, clamped);
        this.roomRenderer.updateEnemyPose(enemy.sprite, enemy.kind, this.player.x, this.player.y);
        this.updateLocalEnemyHpBar(enemy);
        continue;
      }
      if (enemy.kind === "boss") {
        enemy.engaged = true;
        this.updateBossBehavior(enemy, time);
        this.roomRenderer.updateEnemyPose(enemy.sprite, enemy.kind, this.player.x, this.player.y);
        this.updateLocalEnemyHpBar(enemy);
        continue;
      }
      if (["hidden", "gate"].includes(enemy.kind)) {
        enemy.engaged = true;
        enemy.sprite.setVelocity(0);
        const config = enemyPatternConfig(patternTier(enemy.kind));
        const interval = (config.telegraphSeconds + config.cooldownSeconds) * 1_000;
        if (!enemy.patternActive && time - enemy.lastShotAt >= interval) this.fireLocalEnemyPattern(enemy, time);
        this.roomRenderer.updateEnemyPose(enemy.sprite, enemy.kind, this.player.x, this.player.y);
        this.updateLocalEnemyHpBar(enemy);
        continue;
      }
      if (!enemy.engaged) {
        enemy.sprite.setVelocity(0);
        this.roomRenderer.updateEnemyPose(enemy.sprite, enemy.kind, this.player.x, this.player.y);
        this.updateLocalEnemyHpBar(enemy);
        continue;
      }

      if (enemy.kind === "invader") {
        const distance = Phaser.Math.Distance.Between(enemy.sprite.x, enemy.sprite.y, BASE_CORE.x, BASE_CORE.y);
        if (distance <= 54) {
          enemy.sprite.setVelocity(0);
          if (time - enemy.lastAttackAt >= 850) {
            enemy.lastAttackAt = time;
            this.damageBase(enemy.damage);
          }
        } else this.physics.moveTo(enemy.sprite, BASE_CORE.x, BASE_CORE.y, enemy.speed);
        const clamped = clampToWalkable(this.zoneWorld.walkable, enemy.sprite.x, enemy.sprite.y, anchor.x, anchor.y, ENEMY_COLLISION_RADIUS);
        enemy.sprite.setPosition(clamped.x, clamped.y);
        this.lastWalkableEnemyPositions.set(enemy.id, clamped);
        this.roomRenderer.updateEnemyPose(enemy.sprite, enemy.kind, this.player.x, this.player.y);
        this.updateLocalEnemyHpBar(enemy);
        continue;
      }

      if (playerDistance <= 470) {
        this.physics.moveTo(enemy.sprite, this.player.x, this.player.y, enemy.speed);
      } else {
        const clamped = clampToWalkable(this.zoneWorld.walkable, enemy.sprite.x, enemy.sprite.y, anchor.x, anchor.y, ENEMY_COLLISION_RADIUS);
        enemy.sprite.setPosition(clamped.x, clamped.y);
        this.lastWalkableEnemyPositions.set(enemy.id, clamped);
        this.roomRenderer.updateEnemyPose(enemy.sprite, enemy.kind, this.player.x, this.player.y);
        this.updateLocalEnemyHpBar(enemy);
      }

      if (playerDistance <= 34 && time - enemy.lastAttackAt >= 850 && this.hasLineOfSight(enemy.sprite.x, enemy.sprite.y, this.player.x, this.player.y)) {
        enemy.lastAttackAt = time;
        this.damagePlayer(enemy.damage);
      }
      const clamped = clampToWalkable(this.zoneWorld.walkable, enemy.sprite.x, enemy.sprite.y, anchor.x, anchor.y, ENEMY_COLLISION_RADIUS);
      enemy.sprite.setPosition(clamped.x, clamped.y);
      this.lastWalkableEnemyPositions.set(enemy.id, clamped);
      this.roomRenderer.updateEnemyPose(enemy.sprite, enemy.kind, this.player.x, this.player.y);
      this.updateLocalEnemyHpBar(enemy);
    }
  }

  private fireLocalEnemyPattern(enemy: LocalEnemy, time: number): void {
    const patternKind = enemy.patternIndex % 2 === 0 ? "fan" : "floor";
    const tier = patternTier(enemy.kind);
    const config = enemyPatternConfig(tier);
    enemy.patternActive = true;
    enemy.lastShotAt = time;
    this.roomRenderer.updateEnemyPattern(enemy.id, tier, patternKind, "telegraph", enemy.patternIndex, enemy.sprite.x, enemy.sprite.y, true);
    this.time.delayedCall(config.telegraphSeconds * 1_000, () => {
      this.roomRenderer.updateEnemyPattern(enemy.id, tier, patternKind, "idle", enemy.patternIndex, enemy.sprite.x, enemy.sprite.y, false);
      if (!enemy.sprite.active || this.ended) return;
      let hit = false;
      if (patternKind === "floor") {
        hit = enemyFloorPatternCircles(enemy.sprite.x, enemy.sprite.y, enemy.patternIndex, tier)
          .some((circle) => Phaser.Math.Distance.Between(this.player.x, this.player.y, circle.x, circle.y) <= circle.radius);
      } else {
        const dx = this.player.x - enemy.sprite.x;
        const dy = this.player.y - enemy.sprite.y;
        hit = Math.hypot(dx, dy) <= config.range && enemyFanPatternAngles(enemy.patternIndex, tier).some((angle) => {
          const forward = dx * Math.cos(angle) + dy * Math.sin(angle);
          const perpendicular = Math.abs(-dx * Math.sin(angle) + dy * Math.cos(angle));
          return forward >= 0 && forward <= config.range && perpendicular <= 18;
        });
      }
      if (hit && this.hasLineOfSight(enemy.sprite.x, enemy.sprite.y, this.player.x, this.player.y)) this.damagePlayer(enemy.damage);
      enemy.patternIndex += 1;
      enemy.patternActive = false;
    });
  }

  private updateBossBehavior(boss: LocalEnemy, time: number): void {
    if (!boss.sprite.active || this.ended) return;

    // Check HP for Phase 2 Dragon Evolution (HP < 50%)
    const hpRatio = boss.hp / boss.maxHp;
    const isDragonPhase = hpRatio < 0.5;
    if (isDragonPhase && boss.sprite.getData("bossPhase") !== "dragon") {
      boss.sprite.setData("bossPhase", "dragon");
      this.message = "마왕이 불길에 휩싸여 웅장한 용의 형태로 진화했습니다!";
      this.roomRenderer.showImpact(boss.sprite.x, boss.sprite.y, 250, 0xff4500);
      this.cameras.main.shake(400, 0.015);
    }

    if (!isDragonPhase) {
      // PHASE 1: MINOTAUR / BULL FORM (HP >= 50%)
      // Linear Bull Charge + Wall Bounce + 5s Burning Fire Trails (잔상)
      let chargeVx = boss.sprite.getData("chargeVx") as number | undefined;
      let chargeVy = boss.sprite.getData("chargeVy") as number | undefined;
      const nextChargeAt = (boss.sprite.getData("nextChargeAt") as number | undefined) ?? 0;
      const lastTrailAt = (boss.sprite.getData("lastTrailAt") as number | undefined) ?? 0;

      if (time >= nextChargeAt) {
        if (chargeVx === undefined || chargeVx === 0) {
          // Target player's current position and set charge velocity
          const angle = Phaser.Math.Angle.Between(boss.sprite.x, boss.sprite.y, this.player.x, this.player.y);
          chargeVx = Math.cos(angle) * 380;
          chargeVy = Math.sin(angle) * 380;
          boss.sprite.setData("chargeVx", chargeVx);
          boss.sprite.setData("chargeVy", chargeVy);
        }

        // Move boss along linear vector
        boss.sprite.setVelocity(chargeVx, chargeVy);

        // Leave 5-second burning fire trail every 120ms
        if (time - lastTrailAt >= 120) {
          boss.sprite.setData("lastTrailAt", time);
          this.spawnBossFireTrail(boss.sprite.x, boss.sprite.y, time);
        }

        // Clamp position to walkable room floor & detect wall collision
        const anchor = this.lastWalkableEnemyPositions.get(boss.id) ?? { x: boss.sprite.x, y: boss.sprite.y };
        const clamped = clampToWalkable(this.zoneWorld.walkable, boss.sprite.x, boss.sprite.y, anchor.x, anchor.y, 72);

        const isWallBlocked = Math.hypot(clamped.x - boss.sprite.x, clamped.y - boss.sprite.y) > 1.5 ||
                              (boss.sprite.body && (boss.sprite.body.blocked.left || boss.sprite.body.blocked.right || boss.sprite.body.blocked.up || boss.sprite.body.blocked.down));

        boss.sprite.setPosition(clamped.x, clamped.y);
        this.lastWalkableEnemyPositions.set(boss.id, clamped);

        if (isWallBlocked) {
          // Bounce/stop at wall, pause briefly (0.4s recovery), then re-aim and charge continuously!
          boss.sprite.setVelocity(0, 0);
          boss.sprite.setData("chargeVx", 0);
          boss.sprite.setData("chargeVy", 0);
          boss.sprite.setData("nextChargeAt", time + 400); // 0.4s pause before re-aiming
          this.roomRenderer.showImpact(boss.sprite.x, boss.sprite.y, 140, 0xff6600);
          this.cameras.main.shake(220, 0.012);
        }

        // Check collision with player
        const distToPlayer = Phaser.Math.Distance.Between(boss.sprite.x, boss.sprite.y, this.player.x, this.player.y);
        if (distToPlayer <= 85 && time - boss.lastAttackAt >= 600) {
          boss.lastAttackAt = time;
          this.damagePlayer(boss.damage);
          this.roomRenderer.showImpact(this.player.x, this.player.y, 90, 0xff2200);
        }
      } else {
        boss.sprite.setVelocity(0, 0);
      }
    } else {
      // PHASE 2: FIERY DRAGON FORM (HP < 50%)
      // Hovering flight + 360-degree 16-directional radial fireball barrage
      const distToPlayer = Phaser.Math.Distance.Between(boss.sprite.x, boss.sprite.y, this.player.x, this.player.y);
      if (distToPlayer > 120) {
        this.physics.moveTo(boss.sprite, this.player.x, this.player.y, 95);
      } else {
        boss.sprite.setVelocity(0, 0);
      }

      // Radial 16-directional Fireball barrage every 1.5 seconds
      if (time - boss.lastShotAt >= 1500) {
        boss.lastShotAt = time;
        this.fireDragonRadialFireballs(boss.sprite.x, boss.sprite.y, time);
      }

      if (distToPlayer <= 90 && time - boss.lastAttackAt >= 700) {
        boss.lastAttackAt = time;
        this.damagePlayer(boss.damage);
      }
    }

    // Process & update active 5-second fire trails (잔상)
    this.updateBossFireTrails(time);

    // Process & update active radial fireballs
    this.updateDragonFireballs(time);
  }

  private spawnBossFireTrail(x: number, y: number, time: number): void {
    const graphics = this.add.graphics().setDepth(10);
    graphics.fillStyle(0xff3300, 0.7);
    graphics.fillCircle(0, 0, 18);
    graphics.lineStyle(2, 0xffaa00, 0.9);
    graphics.strokeCircle(0, 0, 22);
    graphics.setPosition(x, y);

    this.bossFireTrails.push({
      x,
      y,
      expiresAt: time + 5000, // 5-second persistence
      graphics,
      lastDamageAt: 0,
    });
  }

  private updateBossFireTrails(time: number): void {
    for (let i = this.bossFireTrails.length - 1; i >= 0; i--) {
      const trail = this.bossFireTrails[i];
      if (time >= trail.expiresAt) {
        trail.graphics.clear();
        trail.graphics.destroy();
        this.bossFireTrails.splice(i, 1);
        continue;
      }
      // Pulsating alpha fadeout over last 1 second
      const remainingMs = trail.expiresAt - time;
      if (remainingMs < 1000) {
        trail.graphics.setAlpha(remainingMs / 1000);
      }
      // Stepping on trail deals damage
      const dist = Phaser.Math.Distance.Between(this.player.x, this.player.y, trail.x, trail.y);
      if (dist <= 32 && time - trail.lastDamageAt >= 450) {
        trail.lastDamageAt = time;
        this.damagePlayer(8);
      }
    }
  }

  private fireDragonRadialFireballs(x: number, y: number, time: number): void {
    const count = 16;
    for (let i = 0; i < count; i++) {
      const angle = i * ((Math.PI * 2) / count);
      const speed = 320;
      const vx = Math.cos(angle) * speed;
      const vy = Math.sin(angle) * speed;

      const graphics = this.add.graphics().setDepth(20);
      graphics.fillStyle(0xff1100, 0.95);
      graphics.fillCircle(0, 0, 8);
      graphics.lineStyle(2, 0xffcc00, 1);
      graphics.strokeCircle(0, 0, 10);
      graphics.setPosition(x, y);

      this.dragonFireballs.push({
        x,
        y,
        vx,
        vy,
        createdAt: time,
        graphics,
      });
    }
  }

  private updateDragonFireballs(time: number): void {
    const deltaSec = 0.016;
    for (let i = this.dragonFireballs.length - 1; i >= 0; i--) {
      const fb = this.dragonFireballs[i];
      fb.x += fb.vx * deltaSec;
      fb.y += fb.vy * deltaSec;
      fb.graphics.setPosition(fb.x, fb.y);

      // Check collision with player
      const dist = Phaser.Math.Distance.Between(this.player.x, this.player.y, fb.x, fb.y);
      if (dist <= 24) {
        this.damagePlayer(16);
        this.roomRenderer.showImpact(fb.x, fb.y, 45, 0xff2200);
        fb.graphics.clear();
        fb.graphics.destroy();
        this.dragonFireballs.splice(i, 1);
        continue;
      }

      // Expire after 2.2 seconds
      if (time - fb.createdAt >= 2200) {
        fb.graphics.clear();
        fb.graphics.destroy();
        this.dragonFireballs.splice(i, 1);
      }
    }
  }

  private damageEnemy(enemy: LocalEnemy, damage: number): void {
    if (!enemy.sprite.active) return;
    enemy.engaged = true;
    enemy.hp -= damage;
    this.stats.damage += damage;
    if (enemy.kind === "boss") this.stats.bossDamage += damage;
    enemy.sprite.setTintFill(0xffffff);
    this.time.delayedCall(55, () => enemy.sprite.active && enemy.sprite.clearTint());
    this.updateLocalEnemyHpBar(enemy);
    if (enemy.hp <= 0) this.killEnemy(enemy);
  }

  private killEnemy(enemy: LocalEnemy): void {
    if (enemy.hpBar) {
      enemy.hpBar.clear();
      enemy.hpBar.destroy();
      enemy.hpBar = undefined;
    }
    const x = enemy.sprite.x;
    const y = enemy.sprite.y;
    enemy.sprite.disableBody(true, true);
    this.lastWalkableEnemyPositions.delete(enemy.id);
    this.roomRenderer.updateEnemyPattern(enemy.id, patternTier(enemy.kind), "fan", "idle", enemy.patternIndex, x, y, false);
    this.stats.kills += 1;
    this.gold += enemy.rewardGold;
    this.roomRenderer.showImpact(x, y, enemy.kind === "boss" ? 180 : 45, enemy.kind === "hidden" ? 0xd78cff : 0x8fd99d);
    const leveled = this.progression.addXp(enemy.rewardXp);
    if (leveled && !this.awaitingUpgrade) this.offerNextUpgrade();

    if (enemy.kind === "hidden") this.spawnPersonalDrop(x, y);
    if (enemy.kind === "gate") this.clearGate();
    if (enemy.kind === "boss") {
      this.finishGame("victory", "세 구역을 돌파하고 마왕을 쓰러뜨렸습니다.");
      return;
    }

    if (this.enemies.every((candidate) => !candidate.sprite.active)) {
      this.clearedRooms.add(this.currentRoomId);
      if (this.currentRoom()?.type === "static-monster") {
        const respawnDelay = this.options.sessionMode === "prototype" ? 30_000 : 90_000;
        this.staticRespawnAt.set(this.currentRoomId, this.time.now + respawnDelay);
      }
      if (enemy.kind !== "gate") this.message = "방 정복 완료 · 연결된 문이 열렸습니다.";
    }
  }

  private offerNextUpgrade(): void {
    const level = this.progression.consumeNextDraftLevel();
    if (level === null) return;
    const choices = createAugmentDraft({
      runSeed: this.runSeed,
      playerId: this.options.userId ?? "local",
      heroClass: this.options.heroClass,
      level,
      stacks: this.progression.sharedStacks,
      draftIndex: this.draftIndex++,
    });
    this.awaitingUpgrade = true;
    this.currentDraftIds = new Set(choices.map((choice) => choice.id));
    gameBridge.emit("upgrade", choices.map((choice) => ({
      id: choice.id,
      name: choice.name,
      description: choice.description,
      tag: choice.pool === "milestone" ? "전직" : "공용",
      classId: choice.classId,
      maxStacks: choice.maxStacks,
      rarity: choice.rarity,
      stack: (this.progression.stacks.get(choice.id) ?? 0) + 1,
    })));
    this.message = level === 10 || level === 20 || level === 30
      ? `${level}레벨 전직 증강을 선택하세요.`
      : `${level}레벨 공격 증강을 선택하세요.`;
  }

  private chooseUpgrade(id: UpgradeId): void {
    if (!this.awaitingUpgrade || !this.currentDraftIds.has(id) || !AUGMENT_BY_ID.has(id as AugmentId)) return;
    this.progression.applyUpgrade(id);
    this.awaitingUpgrade = false;
    this.currentDraftIds.clear();
    this.message = `${UPGRADE_MAP.get(id)?.name ?? "증강"} 획득.`;
    if (this.progression.pendingDraftCount > 0) this.time.delayedCall(80, () => this.offerNextUpgrade());
  }

  private spawnPersonalDrop(x: number, y: number): void {
    const item = rollPersonalHiddenDrop({
      runSeed: this.runSeed,
      playerId: this.options.userId ?? "local",
      zone: this.currentZone,
      hiddenRoomId: this.currentRoomId,
    });
    this.drops.push({ item, object: this.roomRenderer.createDrop(x, y, item.rarity) });
    this.message = `${item.rarity === "mythic" ? "신화" : "레전더리"} 개인 장비가 드롭되었습니다.`;
  }

  private updateDrops(): void {
    for (const drop of [...this.drops]) {
      if (!drop.object.active) continue;
      if (Phaser.Math.Distance.Between(this.player.x, this.player.y, drop.object.x, drop.object.y) > 42) continue;
      this.equipDrop(drop.item);
      drop.object.destroy();
      this.drops = this.drops.filter((candidate) => candidate !== drop);
    }
  }

  private equipDrop(item: PersonalHiddenDrop): void {
    const old = this.equipment.get(item.slot);
    if (old && old.item.statMultiplier > item.statMultiplier) {
      this.message = "현재 장비가 더 강해 새 장비를 분해해 20G를 얻었습니다.";
      this.gold += 20;
      return;
    }
    if (old?.hpBonus) {
      this.progression.stats.maxHp -= old.hpBonus;
      this.progression.stats.hp = Math.min(this.progression.stats.hp, this.progression.stats.maxHp);
    }
    const attackBonus = item.slot === "weapon" ? Math.round(10 * item.statMultiplier) : 0;
    const hpBonus = item.slot === "armor" ? Math.round(42 * item.statMultiplier) : 0;
    const defenseBonus = item.slot === "armor" ? Math.max(1, Math.round(4 * item.statMultiplier)) : 0;
    const attackSpeedPercent = item.slot === "accessory" ? Math.round(18 * item.statMultiplier) : 0;
    if (hpBonus) {
      this.progression.stats.maxHp += hpBonus;
      this.progression.stats.hp += hpBonus;
    }
    const rarityName = item.rarity === "mythic" ? "신화" : "레전더리";
    const slotName = item.slot === "weapon" ? "무기" : item.slot === "armor" ? "방어구" : "장신구";
    this.equipment.set(item.slot, {
      item,
      attackBonus,
      hpBonus,
      defenseBonus,
      attackSpeedPercent,
      summary: { slot: item.slot, name: `${rarityName} ${slotName}`, rarity: item.rarity, power: Math.round(item.statMultiplier * 100) },
    });
    this.message = `${rarityName} ${slotName} 자동 장착 완료.`;
  }

  private clearGate(): void {
    this.clearedRooms.add(this.currentRoomId);
    this.clearedGateZones.add(this.currentZone);
    this.stats.gatesDestroyed = this.clearedGateZones.size;
    if (!this.options.editorMap) this.roomRenderer.showWaypoint(this.currentZone === 3 ? "마왕전 진입 웨이포인트" : "다음 구역 웨이포인트");
    this.message = this.options.editorMap ? "몬스터 게이트 파괴 완료 · 연결된 통로를 따라 진행하세요." : "게이트 파괴 완료 · 웨이포인트 위에서 집결 명령을 사용하세요.";
  }

  private updateTravel(deltaSeconds: number): void {
    if (!this.waypointAction) return;
    const action = this.waypointAction;
    const nearby = action === "advance" ? this.isNearGateWaypoint() : this.isNearActiveWaypoint();
    if (!nearby) {
      this.travelProgress = 0;
      this.waypointAction = null;
      this.message = "웨이포인트에서 벗어나 이동이 취소되었습니다.";
      return;
    }
    this.travelProgress = Math.min(1, this.travelProgress + deltaSeconds / WAYPOINT_HOLD_SECONDS);
    if (this.travelProgress < 1) return;
    this.travelProgress = 0;
    this.waypointAction = null;
    if (action === "recall") {
      this.recallToBase();
      return;
    }
    if (this.currentZone === 3) this.enterBossRoom();
    else {
      const nextZone = (this.currentZone + 1) as ZoneId;
      const previous = this.currentRoomId;
      this.currentZone = nextZone;
      const nextRoom = this.worldMap.zones[nextZone - 1].startRoomId;
      this.enterLocalRoom(nextRoom, null);
      this.message = `구역 ${nextZone} 진입 · 이전 게이트 ${previous} 연결 완료.`;
    }
  }

  private enterBossRoom(): void {
    this.clearTransientEntities();
    this.localPhase = "boss";
    this.currentRoomId = "boss";
    this.renderedWaypointKey = "";
    // The boss arena is its own continuous room at world origin.
    const bossRoom: RenderableRoom = { id: "boss", zone: 3, x: 0, y: 0, type: "boss", connections: [] };
    this.zoneWorld = buildRenderWorld([bossRoom], false);
    this.physics.world.setBounds(0, 0, this.zoneWorld.bounds.width, this.zoneWorld.bounds.height);
    this.cameras.main.setBounds(0, 0, this.zoneWorld.bounds.width, this.zoneWorld.bounds.height);
    this.roomRenderer.renderWorld(this.zoneWorld, { decorSeed: this.runSeed, showBuildGrid: false, waypointRooms: new Set() });
    this.setLocalPlayerPosition(640, 580);
    this.spawnEnemy("boss", 640, 300, 3);
    this.message = "마왕전 개시 · 조준점 방향으로 공격을 집중하세요.";
  }

  private updatePassiveGold(deltaMs: number): void {
    if (this.unlockedResources.size === 0) return;
    this.passiveGoldAccumulator += deltaMs;
    while (this.passiveGoldAccumulator >= 5000) {
      this.passiveGoldAccumulator -= 5000;
      this.gold += this.unlockedResources.size;
    }
  }

  private updateStaticRespawn(time: number): void {
    const room = this.currentRoom();
    if (room?.type !== "static-monster") return;
    const respawnAt = this.staticRespawnAt.get(room.id);
    if (respawnAt === undefined || time < respawnAt || this.enemies.some((enemy) => enemy.sprite.active)) return;
    for (const enemy of this.enemies) enemy.sprite.destroy();
    this.enemies = [];
    this.lastWalkableEnemyPositions.clear();
    this.staticRespawnAt.delete(room.id);
    this.clearedRooms.delete(room.id);
    this.spawnRoomContent(room);
    this.message = `정적 몬스터 재출현 · ${this.options.sessionMode === "prototype" ? "30초" : "90초"} 주기`;
  }

  private updateLocalSession(deltaSeconds: number): void {
    if (this.localPhase === "boss" || this.localPhase === "ended") return;
    this.elapsed += deltaSeconds;
    this.phaseRemaining -= deltaSeconds;
    if (this.localPhase === "night") {
      this.nightDamageAccumulator += deltaSeconds;
      if (this.nightDamageAccumulator >= 3) {
        this.nightDamageAccumulator = 0;
        const walls = this.structures.filter((structure) => structure.kind === "wall").length;
        this.damageBase(Math.max(1, 4 + this.localDay - walls * 2));
      }
    }
    if (this.phaseRemaining > 0) return;
    const durations = SESSION_DURATIONS[this.options.sessionMode];
    if (this.localPhase === "day") {
      this.localPhase = "night";
      this.phaseRemaining = durations.night;
      this.message = "밤 공세 · 건설한 장벽이 베이스 피해를 줄입니다.";
    } else if (this.localPhase === "night") {
      this.localPhase = "standby";
      this.phaseRemaining = durations.standby;
      this.gold += 20 + this.localDay * 5;
      this.message = "정산 완료 · 탐험과 건설을 계속하세요.";
    } else {
      this.localDay += 1;
      if (this.localDay > 5) {
        this.finishGame("defeat", "5일 안에 마왕을 쓰러뜨리지 못했습니다.");
        return;
      }
      this.localPhase = "day";
      this.phaseRemaining = durations.day;
      this.progression.stats.hp = Math.min(this.progression.stats.maxHp, this.progression.stats.hp + 14);
      this.message = `${this.localDay}일차 낮 · 다음 구역을 향해 탐색하세요.`;
    }
  }

  private tryBuildAt(worldX: number, worldY: number): void {
    if (!this.isLocalBuildRoom() || !isInsideBuildBounds(this.player.x, this.player.y) || !isInsideBuildBounds(worldX, worldY)) {
      this.message = "구역1 시작 방의 건설 구획 안에서만 배치할 수 있습니다.";
      this.buildMode = null;
      return;
    }
    const x = snapToBuildGrid(worldX);
    const y = snapToBuildGrid(worldY);
    if (this.buildMode === "upgrade") {
      this.upgradeStructureAt(x, y);
      return;
    }
    if (!this.buildMode) return;
    const kind = this.buildMode;
    const cost = BUILDINGS[kind].cost;
    if (this.gold < cost) {
      this.message = `${cost}G가 필요합니다.`;
      return;
    }
    if (this.structures.some((structure) => Phaser.Math.Distance.Between(x, y, structure.sprite.x, structure.sprite.y) < 34)
      || Phaser.Math.Distance.Between(x, y, BASE_CORE.x, BASE_CORE.y) < 88) {
      this.message = "다른 시설이나 베이스 코어와 겹칩니다.";
      return;
    }
    const sprite = this.physics.add.image(x, y, kind).setDepth(10).setImmovable(true);
    this.structures.push({
      id: `structure-${this.structures.length + 1}`,
      kind,
      sprite,
      level: 1,
      hp: kind === "wall" ? 140 : 85,
      nextShotAt: 0,
    });
    this.gold -= cost;
    this.stats.goldSpent += cost;
    this.stats.structuresBuilt += 1;
    this.message = `${kind === "turret" ? "포탑" : "장벽"} 건설 완료.`;
  }

  private upgradeStructureAt(x: number, y: number): void {
    const nearest = [...this.structures]
      .map((structure) => ({ structure, distance: Phaser.Math.Distance.Between(x, y, structure.sprite.x, structure.sprite.y) }))
      .filter(({ distance }) => distance <= 55)
      .sort((left, right) => left.distance - right.distance)[0]?.structure;
    if (!nearest) {
      this.message = "강화할 시설을 선택하세요.";
      return;
    }
    if (nearest.level >= 3) {
      this.message = "이미 최대 레벨입니다.";
      return;
    }
    const definition = BUILDINGS[nearest.kind];
    const nextLevel = nearest.level + 1;
    const cost = definition.upgradeCost[nextLevel - 1];
    if (this.gold < cost) {
      this.message = `${cost}G가 필요합니다.`;
      return;
    }
    this.gold -= cost;
    this.stats.goldSpent += cost;
    nearest.level = nextLevel;
    nearest.hp = Math.round(nearest.hp * 1.5);
    nearest.sprite.setScale(1 + (nextLevel - 1) * 0.12).setTint(nextLevel === 3 ? 0xffdc79 : 0xb5e8d3);
    this.message = `시설 ${nextLevel}레벨 강화 완료.`;
  }

  private updateStructures(time: number): void {
    if (!this.isLocalBuildRoom()) return;
    for (const structure of this.structures) {
      if (structure.kind !== "turret" || time < structure.nextShotAt || !structure.sprite.visible) continue;
      const target = this.enemies
        .filter((enemy) => enemy.sprite.active)
        .map((enemy) => ({ enemy, distance: Phaser.Math.Distance.Between(structure.sprite.x, structure.sprite.y, enemy.sprite.x, enemy.sprite.y) }))
        .filter(({ distance }) => distance <= 270 + structure.level * 35)
        .filter(({ enemy }) => this.hasLineOfSight(structure.sprite.x, structure.sprite.y, enemy.sprite.x, enemy.sprite.y))
        .sort((left, right) => left.distance - right.distance)[0]?.enemy;
      if (!target) continue;
      this.roomRenderer.showAttack(structure.sprite.x, structure.sprite.y, target.sprite.x, target.sprite.y, 0xa9e8cf);
      this.damageEnemy(target, 5 + structure.level * 4);
      structure.nextShotAt = time + 900 - structure.level * 130;
    }
  }

  private updateStructureVisibility(): void {
    const visible = this.isLocalBuildRoom();
    for (const structure of this.structures) structure.sprite.setVisible(visible).setActive(visible);
  }

  private requestWaypointAction(action: "advance" | "recall"): void {
    if (this.localPhase === "boss") return;
    const nearby = action === "advance" ? this.isNearGateWaypoint() : this.isNearActiveWaypoint();
    if (!nearby) {
      this.waypointAction = null;
      this.travelProgress = 0;
      this.message = "활성 웨이포인트 위에서 이동 명령을 사용하세요.";
      return;
    }
    if (this.waypointAction === action) return;
    this.waypointAction = action;
    this.travelProgress = 0;
    this.message = action === "advance"
      ? "다음 구역 웨이포인트 점유 중 · 5초 동안 자리를 지키세요."
      : "귀환 웨이포인트 점유 중 · 5초 동안 자리를 지키세요.";
  }

  private recallToBase(): void {
    const previous = this.currentRoomId;
    this.currentZone = 1;
    this.enterLocalRoom(this.startRoomId(), null);
    this.message = `귀환 완료 · ${previous}에서 베이스로 이동했습니다.`;
  }

  private damagePlayer(rawDamage: number): void {
    if (this.localRespawnAt !== null) return;
    const damage = Math.max(1, Math.round(rawDamage - this.effectiveDefense()));
    this.progression.stats.hp -= damage;
    this.player.setTintFill(0xff7e9e);
    this.time.delayedCall(65, () => this.player.active && this.player.clearTint());
    if (this.progression.stats.hp <= 0) {
      this.stats.deaths += 1;
      this.progression.stats.hp = 0;
      this.player.setVelocity(0);
      this.localRespawnAt = this.time.now + 3_000;
      this.updateDeathPresentation(false, 3);
      this.message = "쓰러졌습니다. 3초 후 베이스에서 부활합니다.";
      this.time.delayedCall(3_000, () => {
        if (this.ended || this.localRespawnAt === null) return;
        this.progression.stats.hp = this.progression.stats.maxHp;
        this.currentZone = 1;
        this.enterLocalRoom(this.startRoomId(), null);
        this.player.setVelocity(0);
        this.localRespawnAt = null;
        this.updateDeathPresentation(true, 0);
        this.message = "베이스에서 완전한 체력으로 부활했습니다.";
        this.emitSnapshot();
      });
    }
  }

  private damageBase(rawDamage: number): void {
    this.baseHp -= Math.max(1, Math.round(rawDamage));
    if (this.baseHp <= 0) this.finishGame("defeat", "베이스캠프가 파괴되었습니다.");
  }

  private handleCommand(command: GameCommand): void {
    if (command.type === "choose-upgrade") {
      if (this.options.runtimeMode === "editor-core") {
        const draftId = this.latestNetwork?.localUpgradeDraft?.draftId;
        if (draftId) localCoreSession.chooseUpgrade(draftId, command.upgradeId);
      } else if (this.options.networked) {
        const draftId = this.latestNetwork?.localUpgradeDraft?.draftId;
        if (draftId) colyseusTransport.chooseUpgrade(draftId, command.upgradeId);
      } else {
        this.chooseUpgrade(command.upgradeId);
      }
    } else if (command.type === "set-build-mode") {
      if (!this.usesAuthoritativeRuntime() && this.isLocalBuildRoom() && isInsideBuildBounds(this.player.x, this.player.y)) {
        this.buildMode = command.buildMode;
      }
    } else if (command.type === "travel") {
      if (this.options.runtimeMode === "editor-core") localCoreSession.requestTravel(command.waypointId, command.destinationId);
      else if (this.options.networked) colyseusTransport.requestTravel(command.waypointId, command.destinationId);
      else this.requestWaypointAction(this.isNearGateWaypoint() ? "advance" : "recall");
    } else if (command.type === "interact") {
      if (this.options.runtimeMode === "editor-core") localCoreSession.interact(command.targetId);
      else if (this.options.networked) colyseusTransport.interact(command.targetId);
    } else if (command.type === "return-base") {
      if (this.options.runtimeMode === "editor-core") localCoreSession.recall();
      else if (this.options.networked) colyseusTransport.requestRecall();
      else if (this.localPhase !== "boss") this.requestWaypointAction("recall");
    } else if (command.type === "enter-boss" && !this.usesAuthoritativeRuntime() && this.currentZone === 3 && this.isNearGateWaypoint()) {
      this.requestWaypointAction("advance");
    }
  }

  private renderNetworkPlaceholder(): void {
    this.message = "서버 방 상태를 기다리는 중입니다.";
  }

  private renderNetworkRoom(snapshot: NetworkWorldSnapshot): void {
    const waypointRooms = this.activeWaypointRooms(snapshot);
    this.roomRenderer.updateWaypoints(this.zoneWorld, waypointRooms);
  }

  private lockedProgressionBarriers(snapshot: NetworkWorldSnapshot): Array<{ x: number; y: number; width: number; height: number }> {
    const progressionWorld = this.progressionWorld;
    if (!progressionWorld) return [];
    const roomState = new Map(snapshot.rooms.map((room) => [room.id, room]));
    const progressionRooms = new Map<string, (typeof progressionWorld.rooms)[number]>(
      progressionWorld.rooms.map((room) => [room.id, room]),
    );
    const bossAccessible = areAuthoredBossGatesCleared(snapshot.day, progressionWorld.gateRoomIds, snapshot.rooms);
    const lockedConnections = progressionWorld.connections.filter((connection) => {
      const from = progressionRooms.get(connection.from);
      const to = progressionRooms.get(connection.to);
      if (!from || !to) return false;
      if (from.id === progressionWorld.bossRoomId || to.id === progressionWorld.bossRoomId) return !bossAccessible;
      if (from.zone === to.zone) return false;
      const lowerZone = Math.min(from.zone, to.zone);
      const gateIds = progressionWorld.gateRoomIds.filter((gateId) => progressionRooms.get(gateId)?.zone === lowerZone);
      return gateIds.length > 0 && gateIds.some((gateId) => !roomState.get(gateId)?.cleared);
    });
    const renderedAnchor = this.zoneWorld.rooms[0];
    const progressionAnchor = renderedAnchor ? progressionRooms.get(renderedAnchor.room.id) : undefined;
    const offsetX = renderedAnchor && progressionAnchor ? renderedAnchor.rect.x - progressionAnchor.rect.x : 0;
    const offsetY = renderedAnchor && progressionAnchor ? renderedAnchor.rect.y - progressionAnchor.rect.y : 0;
    return lockedConnections.map((connection) => {
      const segment = [...connection.floorRects].sort((left, right) => Math.max(right.width, right.height) - Math.max(left.width, left.height))[0]!;
      const horizontal = segment.width >= segment.height;
      return {
        x: segment.x + offsetX + segment.width / 2,
        y: segment.y + offsetY + segment.height / 2,
        width: horizontal ? 18 : Math.max(44, segment.width - 18),
        height: horizontal ? Math.max(44, segment.height - 18) : 18,
      };
    });
  }

  private activeWaypointRooms(snapshot: NetworkWorldSnapshot): Set<string> {
    return new Set(snapshot.waypoints.filter((waypoint) => waypoint.active).map((waypoint) => waypoint.roomId));
  }

  private waypointRenderKey(snapshot: NetworkWorldSnapshot): string {
    return [...this.activeWaypointRooms(snapshot)].sort().join("|");
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
      const visible = isLocal || (
        this.sharesNetworkVisionZone(local.roomId, member.roomId)
        && shouldRenderPartyMember(member)
      );
      sprite.setVisible(visible).setActive(member.connected);
      sprite.setAlpha(isLocal ? (member.alive ? 1 : 0.45) : 0.82);
      const previousAttackSequence = this.networkPlayerAttackSequence.get(member.userId);
      if (!this.options.networked && previousAttackSequence !== undefined && member.attackSequence > previousAttackSequence && visible) {
        const target = snapshot.enemies.find((enemy) => enemy.id === member.attackTargetId);
        if (target) this.roomRenderer.showClassAttack(member.heroClass, sprite, target.x, target.y, member.aim, member.attackCritical);
      }
      this.networkPlayerAttackSequence.set(member.userId, member.attackSequence);
      const previousSkillSequence = this.networkPlayerSkillSequence.get(member.userId);
      if (previousSkillSequence !== undefined && (member.skillSequence ?? 0) > previousSkillSequence && visible) {
        const skillId = member.lastSkillId;
        if (skillId === "dash") {
          this.roomRenderer.showDodge(sprite, member.skillTargetX ?? member.x, member.skillTargetY ?? member.y);
        } else if (skillId === "q" || skillId === "e") {
          this.roomRenderer.showAutoSkill(member.heroClass, skillId, sprite, member.skillTargetX ?? member.x, member.skillTargetY ?? member.y, member.skillRadius ?? 0);
        }
      }
      this.networkPlayerSkillSequence.set(member.userId, member.skillSequence ?? 0);
    }
    this.updateDeathPresentation(local.alive, local.respawnRemaining);
  }

  private receiveNetworkCombatAction(action: CombatActionEvent): void {
    if (this.renderedCombatActionIds.has(action.sequence)) return;
    if (this.renderNetworkCombatAction(action)) this.rememberCombatAction(action.sequence);
    else if (this.pendingCombatActions.length < 256) {
      this.pendingCombatActions.push({ action, expiresAt: performance.now() + 1_000 });
    }
  }

  private renderNetworkCombatAction(action: CombatActionEvent): boolean {
    if (action.attackerType === "player") {
      const member = this.latestNetwork?.players.find((candidate) => candidate.userId === action.attackerId);
      if (!member || !action.heroClass) return false;
      const sprite = member.isLocal || member.userId === this.options.userId
        ? this.player : this.remotePlayers.get(member.userId);
      if (!sprite?.active || !sprite.visible) return false;
      this.roomRenderer.showClassAttack(action.heroClass, sprite, action.targetX, action.targetY, action.aim, action.critical);
      return true;
    }
    const sprite = this.networkEnemies.get(action.attackerId);
    if (!sprite?.active || !sprite.visible) return false;
    if (action.actionKind === "melee") {
      this.roomRenderer.showEnemyMeleeAttack(sprite, action.targetX, action.targetY);
    } else {
      const enemy = this.latestNetwork?.enemies.find((candidate) => candidate.id === action.attackerId);
      if (!enemy || !action.patternKind) return false;
      const kind: LocalEnemyKind = enemy.kind === "boss" || enemy.behavior === "boss" ? "boss"
        : enemy.kind === "gate" || enemy.behavior === "gate" ? "gate" : "hidden";
      this.roomRenderer.updateEnemyPattern(
        enemy.id,
        patternTier(kind),
        action.patternKind,
        action.actionKind === "pattern-telegraph" ? "telegraph" : "idle",
        enemy.patternIndex,
        action.startX,
        action.startY,
        true,
      );
      if (action.actionKind === "pattern-resolve") this.roomRenderer.showImpact(action.targetX, action.targetY, 38, 0xff596c);
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
    const activeIds = new Set(enemies.map((enemy) => enemy.id));
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
      const kind: LocalEnemyKind = enemy.kind === "boss" || enemy.behavior === "boss" ? "boss"
        : enemy.kind === "gate" || enemy.behavior === "gate" ? "gate"
          : enemy.kind === "hidden" || enemy.kind === "hidden-ranged" || enemy.behavior === "hidden" ? "hidden"
            : enemy.kind === "invader" || enemy.behavior === "invader" ? "invader" : "static";
      const sprite = this.networkEnemies.get(enemy.id);
      if (!sprite) continue;
      const visible = enemy.alive
        && this.sharesNetworkVisionZone(local.roomId, enemy.roomId);

      const previousHp = this.networkEnemyHp.get(enemy.id);
      if (previousHp !== undefined && enemy.hp < previousHp && visible) {
        this.roomRenderer.showImpact(enemy.x, enemy.y, 30, 0xffffff);
      }
      this.networkEnemyHp.set(enemy.id, enemy.hp);

      // attackSequence is state-recovery metadata; live visuals use combat.action.
      this.networkEnemyAttackSequence.set(enemy.id, enemy.attackSequence);
      sprite.setVisible(visible).setActive(enemy.alive);
      this.roomRenderer.updateEnemyPattern(
        enemy.id,
        patternTier(kind),
        enemy.patternKind,
        enemy.patternPhase,
        enemy.patternIndex,
        enemy.x,
        enemy.y,
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
      const kind: LocalEnemyKind = enemy.kind === "boss" || enemy.behavior === "boss" ? "boss"
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
    const snapshot = this.usesAuthoritativeRuntime() ? this.createNetworkGameSnapshot() : this.createLocalGameSnapshot();
    gameBridge.emit("snapshot", snapshot);
  }

  private createLocalGameSnapshot(): GameSnapshot {
    const roomMap = this.localRoomMap();
    const currentRoom = this.currentRoom();
    const waypointNearby = this.isNearActiveWaypoint();
    const advancesZone = !this.options.editorMap && currentRoom?.type === "gate" && this.clearedGateZones.has(this.currentZone);
    const destinationId = advancesZone
      ? this.currentZone === 3 ? "boss" : this.worldMap.zones[this.currentZone].startRoomId
      : this.startRoomId();
    const equipped = [...this.equipment.values()].map((item) => item.summary);
    const teamPower = this.progression.powerScore + equipped.reduce((sum, item) => sum + item.power, 0);
    const boss = this.boss?.sprite.active ? this.boss : null;
    const minimap = this.localMiniMap();
    const explored = minimap ? calculateExplorationPercent(minimap.geometry, minimap.explorationMask) : 0;
    return {
      worldMode: this.options.editorMap ? "editor" : "procedural",
      running: !this.ended,
      phase: this.localPhase,
      phaseLabel: PHASE_LABELS[this.localPhase],
      day: Math.min(5, this.localDay),
      phaseRemaining: Math.max(0, this.phaseRemaining),
      elapsed: this.elapsed,
      hp: Math.max(0, this.progression.stats.hp),
      maxHp: this.progression.stats.maxHp,
      baseHp: Math.max(0, this.baseHp),
      baseMaxHp: BASE_MAX_HP,
      level: this.progression.level,
      xp: this.progression.xp,
      xpToNext: this.progression.xpToNext,
      gold: this.gold,
      teamPower,
      gatesDestroyed: this.options.editorMap
        ? roomMap.filter((room) => room.type === "gate" && room.cleared).length
        : this.clearedGateZones.size,
      buildMode: this.buildMode,
      qCooldown: Math.max(0, (this.qReadyAt - this.time.now) / 1000),
      eCooldown: Math.max(0, (this.eReadyAt - this.time.now) / 1000),
      dashCooldown: Math.max(0, (this.dashReadyAt - this.time.now) / 1000),
      bossAvailable: !this.options.editorMap && this.currentZone === 3 && this.clearedGateZones.has(3) && this.currentRoom()?.type === "gate",
      bossHp: boss ? Math.max(0, boss.hp) : null,
      bossMaxHp: boss?.maxHp ?? null,
      message: this.message,
      upgrades: [...this.progression.stacks.entries()].map(([id, stack]) => ({ name: UPGRADE_MAP.get(id)?.name ?? id, stack })).slice(-4),
      stats: { ...this.stats },
      party: [{
        userId: this.options.userId ?? "local",
        displayName: "나",
        heroClass: this.options.heroClass,
        hp: Math.max(0, this.progression.stats.hp),
        maxHp: this.progression.stats.maxHp,
        level: this.progression.level,
        teamPower,
        ready: true,
        connected: true,
        alive: this.localRespawnAt === null,
        respawnRemaining: this.localRespawnAt === null ? 0 : Math.max(0, (this.localRespawnAt - this.time.now) / 1_000),
        roomId: this.currentRoomId,
        x: this.player.x,
        y: this.player.y,
        aim: 0,
        attackSequence: this.attackCounter,
        attackTargetId: this.lastLocalTargetId ?? "",
        attackCritical: this.lastLocalAttackCritical,
        isLocal: true,
        equipment: equipped,
      }],
      currentZone: this.currentZone,
      currentRoomId: this.currentRoomId,
      roomsExplored: roomMap.filter((room) => (this.options.editorMap || room.zone === this.currentZone) && room.visited).length,
      roomMap,
      minimap,
      explorationPercent: explored,
      equipment: equipped,
      combatStats: {
        attackDamage: this.effectiveAttack(),
        defense: this.effectiveDefense(),
        criticalChance: (this.progression.stacks.get("precision") ?? 0) * 6,
        criticalDamage: 150 + (this.progression.stacks.get("ferocity") ?? 0) * 20,
        attacksPerSecond: 1_000 / this.effectiveAttackInterval(),
        attackRange: this.effectiveAttackRange(),
        moveSpeed: this.progression.stats.moveSpeed,
      },
      buildSupported: true,
      inBuildZone: this.isLocalBuildRoom() && isInsideBuildBounds(this.player.x, this.player.y),
      waypoint: {
        nearby: waypointNearby,
        id: waypointNearby ? `${this.currentRoomId}:waypoint` : null,
        label: currentRoom?.type === "gate" ? "게이트 웨이포인트"
          : currentRoom?.type === "central-waypoint" ? "중앙 웨이포인트" : "베이스 웨이포인트",
        destinationLabel: advancesZone
          ? this.currentZone === 3 ? "마왕의 제단" : `구역 ${this.currentZone + 1}`
          : "베이스캠프",
        destinationId,
        holdProgress: this.travelProgress,
        requiredPlayers: 1,
        presentPlayers: waypointNearby ? 1 : 0,
      },
    };
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
    const destinationWaypoint = state?.waypoints.find((waypoint) => waypoint.id === activeWaypoint?.destinationId);
    const destinationRoomId = destinationWaypoint?.roomId ?? activeWaypoint?.destinationId;
    const waypointDestination = roomMap.find((room) => room.id === destinationRoomId);
    const connectedAlivePlayers = state?.players.filter((member) => member.connected && member.alive).length ?? 1;
    const requiredPlayers = activeWaypoint && activeWaypoint.requiredPlayers > 0
      ? activeWaypoint.requiredPlayers
      : this.options.partyMode === "solo" ? 1 : Math.max(1, connectedAlivePlayers);
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
      buildMode: this.buildMode,
      qCooldown: local?.qCooldown ?? 0,
      eCooldown: local?.eCooldown ?? 0,
      dashCooldown: 0,
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
        label: activeWaypoint?.kind === "gate" ? "게이트 웨이포인트"
          : activeWaypoint?.kind === "central" ? "중앙 웨이포인트"
            : activeWaypoint?.kind === "boss" ? "마왕전 웨이포인트" : "베이스 웨이포인트",
        destinationLabel: activeWaypoint?.destinationId === "boss:arena" || activeWaypoint?.destinationId === "boss" ? "마왕의 제단"
          : waypointDestination ? `구역 ${waypointDestination.zone}` : "베이스캠프",
        destinationId: activeWaypoint?.destinationId ?? "",
        holdProgress: activeWaypoint?.holdProgress ?? state?.waypointHoldProgress ?? 0,
        requiredPlayers,
        presentPlayers: activeWaypoint?.holdingPlayers ?? 0,
      },
    };
  }

  private localMiniMap(): MiniMapSnapshot | null {
    if (!this.zoneWorld?.walkable.length) return null;
    const areaId = this.options.editorMap ? "editor" : `zone-${this.currentZone}`;
    const mapRevision = `${this.runSeed}:${areaId}`;
    let snapshot = this.localMiniMaps.get(areaId);
    if (!snapshot || snapshot.geometry.mapRevision !== mapRevision) {
      const bounds = this.zoneWorld.bounds;
      const grid = createMiniMapGrid(bounds);
      const surfaces = this.zoneWorld.walkable.map((rect, index) => rectToMiniMapSurface(rect, `${areaId}:surface:${index}`));
      const markers = this.zoneWorld.rooms.flatMap((entry) => {
        const kind = entry.room.type === "gate" ? "gate" : entry.room.type === "boss" ? "boss"
          : entry.room.type === "central-waypoint" || entry.room.type === "start" ? "waypoint" : null;
        return kind ? [{
          id: `${entry.room.id}:marker`, kind, label: kind === "boss" ? "마왕의 제단" : kind === "gate" ? "구역 게이트" : "활성 웨이포인트",
          x: entry.center.x, y: entry.center.y, areaId,
        }] : [];
      });
      const geometry = {
        mapRevision,
        areaId,
        bounds,
        ...grid,
        surfaces,
        wallSegments: this.zoneWorld.wallSegments,
        visionRadius: PLAYER_VISION_RADIUS,
        markers,
      } as MiniMapSnapshot["geometry"];
      snapshot = { geometry, explorationMask: createExplorationMask(geometry), revision: 0 };
      this.localMiniMaps.set(areaId, snapshot);
    }
    const newlyRevealed = revealAround(snapshot.geometry, snapshot.explorationMask, this.player.x, this.player.y);
    if (newlyRevealed.length > 0) snapshot.revision += 1;
    return snapshot;
  }

  private localRoomMap(): RoomMapCell[] {
    return this.allLocalRooms().map((room): RoomMapCell => ({
      id: room.id,
      zone: room.zone,
      x: room.x,
      y: room.y,
      type: room.type,
      visited: this.visitedRooms.has(room.id),
      current: room.id === this.currentRoomId,
      cleared: this.clearedRooms.has(room.id),
      connections: [...room.connections],
    }));
  }

  private finishGame(state: "victory" | "defeat", reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.localPhase = "ended";
    this.player.setVelocity(0);
    this.physics.pause();
    const result: GameResult = {
      state,
      reason,
      elapsed: this.elapsed,
      day: Math.min(5, this.localDay),
      level: this.progression.level,
      teamPower: this.progression.powerScore,
      stats: { ...this.stats },
    };
    gameBridge.emit("result", result);
    this.emitSnapshot();
  }

  private clearTransientEntities(): void {
    for (const enemy of this.enemies) {
      this.roomRenderer.updateEnemyPattern(enemy.id, patternTier(enemy.kind), "fan", "idle", enemy.patternIndex, enemy.sprite.x, enemy.sprite.y, false);
      if (enemy.hpBar) {
        enemy.hpBar.clear();
        enemy.hpBar.destroy();
      }
      enemy.sprite.destroy();
    }
    for (const drop of this.drops) drop.object.destroy();
    for (const drop of this.networkDrops.values()) drop.destroy();
    this.enemies = [];
    this.lastWalkableEnemyPositions.clear();
    this.drops = [];
    this.networkDrops.clear();
    this.networkDropRequests.clear();
    this.boss = null;
  }

  private setLocalPlayerPosition(x: number, y: number): void {
    this.player.setPosition(x, y);
    this.lastWalkablePlayerPosition = { x, y };
  }

  private allLocalRooms(): readonly LocalMapRoom[] {
    if (this.editorRooms.length > 0) return this.editorRooms;
    return this.worldMap.zones.flatMap((zone) => zone.rooms) as readonly LocalMapRoom[];
  }

  private currentRoom(): LocalMapRoom | undefined {
    if (this.currentRoomId === "boss") return undefined;
    return this.allLocalRooms().find((room) => room.id === this.currentRoomId);
  }

  private startRoomId(): string {
    return this.editorRooms.find((room) => room.type === "start")?.id ?? this.worldMap.zones[0].startRoomId;
  }

  private isLocalBuildRoom(): boolean {
    const room = this.currentRoom();
    return room?.zone === 1 && room.type === "start";
  }

  private isNearGateWaypoint(): boolean {
    if (this.options.editorMap) return false;
    const room = this.currentRoom();
    const center = this.currentRoomCenter();
    return Boolean(room?.type === "gate" && this.clearedGateZones.has(room.zone)
      && center && Phaser.Math.Distance.Between(this.player.x, this.player.y, center.x, center.y) <= 95);
  }

  private isNearActiveWaypoint(): boolean {
    const room = this.currentRoom();
    const active = room?.type === "start"
      || room?.type === "central-waypoint"
      || (room?.type === "gate" && this.clearedGateZones.has(room.zone));
    const center = this.currentRoomCenter();
    return Boolean(active && center && Phaser.Math.Distance.Between(this.player.x, this.player.y, center.x, center.y) <= 95);
  }

  private currentRoomCenter(): { x: number; y: number } | undefined {
    return this.zoneWorld.rooms.find((entry) => entry.room.id === this.currentRoomId)?.center;
  }

  private waypointWorldCenter(roomId: string): { x: number; y: number } | undefined {
    return this.zoneWorld.rooms.find((entry) => entry.room.id === roomId)?.center;
  }

  private aimAngle(): number {
    const pointer = this.input.activePointer;
    const worldPointer = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    return aimAngleBetween(this.player, worldPointer);
  }

  private hasLineOfSight(fromX: number, fromY: number, toX: number, toY: number): boolean {
    return clipWalkableLine(this.zoneWorld.walkable, fromX, fromY, toX, toY).clear;
  }

  private aimConeHalfAngle(): number {
    const baseAngle = CLASS_COMBAT_RULES[this.options.heroClass].coneHalfAngle;
    return this.options.heroClass === "swordsman" && this.progression.has("swordsman-whirlwind")
      ? baseAngle * 1.45
      : baseAngle;
  }

  private effectiveAttack(): number {
    return this.progression.stats.attack + (this.equipment.get("weapon")?.attackBonus ?? 0);
  }

  private effectiveAttackRange(): number {
    const baseRange = this.progression.has("swordsman-blade")
      ? Math.max(240, this.progression.stats.attackRange)
      : this.progression.stats.attackRange;
    return this.localPhase === "night" ? baseRange * NIGHT_ATTACK_RANGE_MULTIPLIER : baseRange;
  }

  private effectiveDefense(): number {
    return this.progression.stats.defense + (this.equipment.get("armor")?.defenseBonus ?? 0);
  }

  private effectiveAttackInterval(): number {
    return Math.max(110, Math.round(this.progression.stats.attackIntervalMs * (1 - (this.equipment.get("accessory")?.attackSpeedPercent ?? 0) / 100)));
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

  private usesAuthoritativeRuntime(): boolean {
    return this.options.runtimeMode === "editor-core"
      || this.options.runtimeMode === "server"
      || Boolean(this.options.networked);
  }

  private configureVisionWorld(): void {
    if (!this.visionFog || !this.zoneWorld) return;
    const revision = this.zoneWorld.wallSegments
      .map((segment) => `${segment.x1},${segment.y1},${segment.x2},${segment.y2}`)
      .join("|");
    this.visionFog.setWorld(this.zoneWorld.wallSegments, revision);
  }
}

function normalizeZone(value: number): ZoneId {
  if (value === 2 || value === 3) return value;
  return 1;
}

function patternTier(kind: LocalEnemyKind): "hidden" | "gate" | "boss" {
  if (kind === "boss") return "boss";
  if (kind === "gate") return "gate";
  return "hidden";
}
