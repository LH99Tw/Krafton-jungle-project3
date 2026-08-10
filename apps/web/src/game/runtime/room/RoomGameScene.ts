import * as Phaser from "phaser";
import {
  AUGMENT_BY_ID,
  CLASS_COMBAT_RULES,
  createAugmentDraft,
  createSeededRandom,
  generateThreeZoneMap,
  rollPersonalHiddenDrop,
  type AugmentId,
  type PersonalHiddenDrop,
  type ThreeZoneMap,
  type ZoneId,
  type ZoneRoom,
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
  PartyMemberSnapshot,
  Phase,
  RoomMapCell,
  TeamStats,
  UpgradeId,
} from "../../domain/types";
import { ProgressionModel } from "../../systems/ProgressionModel";
import { colyseusTransport } from "../../transport/ColyseusTransport";
import { gameBridge, type GameCommand } from "../GameBridge";
import {
  BASE_CORE,
  ROOM_VIEW,
  clampToRoom,
  directionBetween,
  doorLayouts,
  doorPosition,
  isInsideBuildBounds,
  snapToBuildGrid,
  type DoorLayout,
  type RenderableRoom,
} from "./layout";
import { RoomRenderer, classColor } from "./RoomRenderer";

type LocalEnemyKind = "static" | "hidden" | "gate" | "invader" | "boss";

type LocalEnemy = {
  id: string;
  kind: LocalEnemyKind;
  sprite: Phaser.Physics.Arcade.Sprite;
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

export class RoomGameScene extends Phaser.Scene {
  private readonly classDefinition;
  private readonly difficulty;
  private readonly runSeed: string;
  private readonly worldMap: ThreeZoneMap;
  private readonly progression: ProgressionModel;
  private roomRenderer!: RoomRenderer;
  private player!: Phaser.Physics.Arcade.Sprite;
  private keys!: Record<"W" | "A" | "S" | "D" | "Q" | "E" | "SPACE" | "B", Phaser.Input.Keyboard.Key>;
  private commandDisconnect?: () => void;
  private networkDisconnect?: () => void;
  private enemies: LocalEnemy[] = [];
  private drops: LocalDrop[] = [];
  private structures: LocalStructure[] = [];
  private readonly remotePlayers = new Map<string, Phaser.Physics.Arcade.Sprite>();
  private readonly networkEnemies = new Map<string, Phaser.Physics.Arcade.Sprite>();
  private readonly networkDrops = new Map<string, Phaser.GameObjects.Container>();
  private readonly networkDropRequests = new Map<string, number>();
  private readonly visitedRooms = new Set<string>();
  private readonly clearedRooms = new Set<string>();
  private readonly unlockedResources = new Set<string>();
  private readonly clearedGateZones = new Set<number>();
  private readonly staticRespawnAt = new Map<string, number>();
  private readonly equipment = new Map<EquipmentSummary["slot"], EquippedRuntime>();
  private currentZone: ZoneId = 1;
  private currentRoomId: string;
  private currentDoors: DoorLayout[] = [];
  private localPhase: Phase = "day";
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
  private transitionReadyAt = 0;
  private snapshotAccumulator = 0;
  private passiveGoldAccumulator = 0;
  private nightDamageAccumulator = 0;
  private waypointAction: "advance" | "recall" | null = null;
  private travelProgress = 0;
  private awaitingUpgrade = false;
  private draftIndex = 0;
  private currentDraftIds = new Set<UpgradeId>();
  private attackCounter = 0;
  private ended = false;
  private message = "연결된 문을 따라 첫 구역을 탐색하세요.";
  private latestNetwork: NetworkWorldSnapshot | null = null;
  private renderedNetworkRoomKey = "";
  private renderedNetworkDraftId: string | null | undefined;
  private boss: LocalEnemy | null = null;
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
    this.currentRoomId = this.worldMap.zones[0].startRoomId;
    this.phaseRemaining = SESSION_DURATIONS[options.sessionMode].day;
    this.progression = new ProgressionModel({
      ...this.classDefinition.stats,
      hp: this.classDefinition.stats.maxHp,
    });
  }

  create(): void {
    this.physics.world.setBounds(0, 0, ROOM_VIEW.width, ROOM_VIEW.height);
    this.roomRenderer = new RoomRenderer(this);
    this.roomRenderer.create();
    this.player = this.roomRenderer.createHero(this.options.heroClass, 360, 535);
    this.player.setVisible(!this.options.networked);
    this.configureInput();
    this.commandDisconnect = gameBridge.connect((command) => this.handleCommand(command));

    if (this.options.networked) {
      this.networkDisconnect = gameBridge.on("network", (snapshot) => this.syncNetworkState(snapshot));
      const initialSnapshot = colyseusTransport.snapshot;
      if (initialSnapshot) this.syncNetworkState(initialSnapshot);
      else this.renderNetworkPlaceholder();
    } else {
      this.enterLocalRoom(this.currentRoomId, null);
    }

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.cleanup());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.cleanup());
    gameBridge.emit("ready", undefined);
    this.emitSnapshot();
  }

  update(time: number, delta: number): void {
    this.roomRenderer.updateCrosshair(this.input.activePointer);
    if (this.ended) return;
    const safeDeltaMs = Math.min(100, Math.max(0, delta));

    if (this.options.networked) {
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
    this.checkDoorTransition(time);

    this.snapshotAccumulator += safeDeltaMs;
    if (this.snapshotAccumulator >= 120) {
      this.snapshotAccumulator = 0;
      this.emitSnapshot();
    }
  }

  /** Server snapshots are the only simulation source while networked. */
  public syncNetworkState(snapshot: NetworkWorldSnapshot): void {
    if (!this.options.networked || this.ended) return;
    this.latestNetwork = snapshot;
    const local = snapshot.players.find((member) => member.isLocal)
      ?? snapshot.players.find((member) => member.userId === this.options.userId);
    if (!local) return;
    const draftId = snapshot.localUpgradeDraft?.draftId ?? null;
    if (this.renderedNetworkDraftId !== draftId) {
      this.renderedNetworkDraftId = draftId;
      gameBridge.emit("upgrade", snapshot.localUpgradeDraft?.choices ?? []);
    }
    this.currentRoomId = local.roomId;
    this.currentZone = normalizeZone(snapshot.currentZone);
    const serverRoom = snapshot.rooms.find((room) => room.id === local.roomId);
    const waypointActive = snapshot.waypoints.some((waypoint) => waypoint.roomId === local.roomId && waypoint.active);
    const roomKey = [local.roomId, serverRoom?.type, serverRoom?.cleared, serverRoom?.connections.join(","), waypointActive].join("|");
    if (this.renderedNetworkRoomKey !== roomKey) {
      this.renderedNetworkRoomKey = roomKey;
      this.renderNetworkRoom(snapshot, local);
    }
    this.syncNetworkPlayers(snapshot.players, local.roomId);
    this.syncNetworkEnemies(snapshot, local.roomId);
    this.syncNetworkDrops(snapshot, local.roomId);
    this.emitSnapshot();
  }

  private configureInput(): void {
    if (!this.input.keyboard) return;
    this.keys = this.input.keyboard.addKeys("W,A,S,D,Q,E,SPACE,B") as typeof this.keys;
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (!this.options.networked && this.buildMode) this.tryBuildAt(pointer.worldX, pointer.worldY);
    });
  }

  private enterLocalRoom(roomId: string, sourceRoomId: string | null): void {
    this.clearTransientEntities();
    const zone = this.zoneMap();
    const room = zone.rooms.find((candidate) => candidate.id === roomId);
    if (!room) throw new Error(`Unknown local room: ${roomId}`);
    this.currentRoomId = room.id;
    this.currentZone = room.zone;
    this.visitedRooms.add(room.id);
    this.currentDoors = doorLayouts(room, zone.rooms);
    const waypointActive = room.type === "start"
      || room.type === "central-waypoint"
      || (room.type === "gate" && this.clearedGateZones.has(room.zone));
    this.roomRenderer.renderRoom(room, this.currentDoors, {
      showBuildGrid: room.type === "start" && room.zone === 1,
      waypointActive,
    });

    if (sourceRoomId) {
      const source = zone.rooms.find((candidate) => candidate.id === sourceRoomId);
      const entryDirection = source ? directionBetween(room, source) : null;
      const spawn = entryDirection ? doorPosition(entryDirection) : { spawnX: 640, spawnY: 560 };
      this.player.setPosition(spawn.spawnX, spawn.spawnY);
    } else if (room.type === "start" && room.zone === 1) {
      this.player.setPosition(360, 535);
    } else {
      this.player.setPosition(640, 560);
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
    else if (room.type !== "gate") this.message = "정복한 방입니다. 연결된 문으로 이동할 수 있습니다.";
  }

  private spawnRoomContent(room: ZoneRoom): void {
    if (room.type === "static-monster") {
      const count = 2 + room.zone;
      for (let index = 0; index < count; index += 1) {
        const angle = (Math.PI * 2 * index) / count;
        this.spawnEnemy("static", 640 + Math.cos(angle) * 155, 340 + Math.sin(angle) * 115, room.zone);
      }
      this.message = "정적 몬스터는 먼저 공격하기 전까지 움직이지 않습니다.";
    } else if (room.type === "hidden-monster") {
      this.spawnEnemy("hidden", 640, 330, room.zone);
      this.message = "숨겨진 수호자 · 강력한 원거리 공격을 경계하세요.";
    } else if (room.type === "gate") {
      this.spawnEnemy("gate", 640, 330, room.zone);
      this.message = `구역 ${room.zone} 게이트를 파괴하면 웨이포인트가 활성화됩니다.`;
    } else {
      this.clearedRooms.add(room.id);
    }
  }

  private spawnEnemy(kind: LocalEnemyKind, x: number, y: number, zone: number): LocalEnemy {
    const zoneScale = 1 + (zone - 1) * 0.3;
    const base = kind === "hidden"
      ? { hp: 145, damage: 14, speed: 68, xp: 38, gold: 24 }
      : kind === "gate"
        ? { hp: 130, damage: 0, speed: 0, xp: 32, gold: 30 }
        : kind === "boss"
          ? { hp: 620, damage: 20, speed: 0, xp: 0, gold: 0 }
          : kind === "invader"
            ? { hp: 28, damage: 9, speed: 92, xp: 7, gold: 5 }
            : { hp: 24, damage: 8, speed: 78, xp: 8, gold: 6 };
    const maxHp = Math.round(base.hp * zoneScale * this.difficulty.enemyHp);
    const enemy: LocalEnemy = {
      id: `${this.currentRoomId}:${kind}:${this.attackCounter++}`,
      kind,
      sprite: this.roomRenderer.createEnemy(kind, x, y),
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
    };
    this.enemies.push(enemy);
    if (kind === "boss") this.boss = enemy;
    return enemy;
  }

  private updateLocalPlayer(time: number): void {
    if (!this.player.active) return;
    const x = Number(this.keys.D?.isDown) - Number(this.keys.A?.isDown);
    const y = Number(this.keys.S?.isDown) - Number(this.keys.W?.isDown);
    const movement = new Phaser.Math.Vector2(x, y).normalize().scale(this.progression.stats.moveSpeed);
    this.player.setVelocity(movement.x, movement.y);
    const aim = this.aimAngle();
    this.player.setFlipX(Math.cos(aim) < 0);

    if (Phaser.Input.Keyboard.JustDown(this.keys.Q) && time >= this.qReadyAt) this.useSkill("q", aim);
    if (Phaser.Input.Keyboard.JustDown(this.keys.E) && time >= this.eReadyAt) this.useSkill("e", aim);
    if (Phaser.Input.Keyboard.JustDown(this.keys.SPACE) && time >= this.dashReadyAt) this.useDash(aim);
    if (Phaser.Input.Keyboard.JustDown(this.keys.B) && this.localPhase !== "boss") this.requestWaypointAction("recall");

    const clamped = clampToRoom(this.player.x, this.player.y);
    this.player.setPosition(clamped.x, clamped.y);
    if (!this.isLocalBuildRoom() || !isInsideBuildBounds(this.player.x, this.player.y)) this.buildMode = null;
  }

  private updateAutoAttack(time: number): void {
    const interval = this.effectiveAttackInterval();
    if (time < this.lastAutoAttackAt) return;
    const aim = this.aimAngle();
    const targets = this.findAimConeTargets(this.progression.stats.attackRange, aim);
    if (targets.length === 0) return;
    const projectileCount = Math.max(1, this.progression.stats.projectileCount + (this.progression.has("archer-volley") ? 1 : 0));
    const selected = targets.slice(0, this.classDefinition.attackKind === "melee" ? 1 : projectileCount);
    for (const target of selected) {
      this.roomRenderer.showAttack(this.player.x, this.player.y, target.sprite.x, target.sprite.y, classColor(this.options.heroClass));
      this.damageEnemy(target, this.rollAttackDamage(target));
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
      .sort((left, right) => left.distance - right.distance || left.enemy.id.localeCompare(right.enemy.id))
      .map(({ enemy }) => enemy);
  }

  private rollAttackDamage(target: LocalEnemy): number {
    this.attackCounter += 1;
    let damage = this.effectiveAttack();
    const precision = (this.progression.stacks.get("precision") ?? 0) * 0.06;
    const critical = createSeededRandom(`${this.runSeed}:attack:${this.attackCounter}`).next() < precision;
    if (critical) damage *= 1.5 + (this.progression.stacks.get("ferocity") ?? 0) * 0.2;
    if (["hidden", "gate", "boss"].includes(target.kind)) damage *= 1 + (this.progression.stacks.get("boss-hunter") ?? 0) * 0.12;
    if (this.progression.has("swordsman-execution") && target.hp / target.maxHp <= 0.3) damage *= 1.6;
    if (this.progression.has("archer-sniper")) {
      const distance = Phaser.Math.Distance.Between(this.player.x, this.player.y, target.sprite.x, target.sprite.y);
      damage *= 1 + Math.min(0.55, Math.max(0, distance - 180) / 510);
    }
    return Math.max(1, Math.round(damage));
  }

  private useSkill(skill: "q" | "e", aim: number): void {
    const definition = this.classDefinition.skills[skill === "q" ? 0 : 1];
    const cooldownReduction = Math.min(0.6, (this.progression.stacks.get("skill-haste") ?? 0) * 0.06 + (this.progression.has("mage-tempo") ? 0.25 : 0));
    if (skill === "q") this.qReadyAt = this.time.now + definition.cooldownMs * (1 - cooldownReduction);
    else this.eReadyAt = this.time.now + definition.cooldownMs * (1 - cooldownReduction);
    const damage = Math.round(this.effectiveAttack() * (skill === "q" ? 2.1 : 1.65) * this.progression.stats.skillPower);
    const targetX = this.player.x + Math.cos(aim) * 125;
    const targetY = this.player.y + Math.sin(aim) * 125;
    const radius = 120 * (1 + (this.progression.stacks.get("area-power") ?? 0) * 0.12);
    for (const enemy of this.enemies) {
      if (!enemy.sprite.active) continue;
      if (Phaser.Math.Distance.Between(targetX, targetY, enemy.sprite.x, enemy.sprite.y) <= radius) this.damageEnemy(enemy, damage);
    }
    this.roomRenderer.showImpact(targetX, targetY, radius, classColor(this.options.heroClass));
  }

  private useDash(aim: number): void {
    this.dashReadyAt = this.time.now + 5000;
    const body = this.player.body as Phaser.Physics.Arcade.Body;
    const direction = new Phaser.Math.Vector2(body.velocity.x, body.velocity.y);
    if (direction.lengthSq() < 1) direction.setToPolar(aim, 1);
    direction.normalize().scale(145);
    const point = clampToRoom(this.player.x + direction.x, this.player.y + direction.y);
    this.player.setPosition(point.x, point.y).setAlpha(0.35);
    this.time.delayedCall(220, () => this.player.active && this.player.setAlpha(1));
  }

  private updateEnemies(time: number): void {
    for (const enemy of this.enemies) {
      if (!enemy.sprite.active) continue;
      if (enemy.kind === "gate" || enemy.kind === "boss") enemy.sprite.setVelocity(0);
      if (!enemy.engaged) {
        enemy.sprite.setVelocity(0);
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
        continue;
      }

      const playerDistance = Phaser.Math.Distance.Between(enemy.sprite.x, enemy.sprite.y, this.player.x, this.player.y);
      if (enemy.kind === "hidden" || enemy.kind === "boss") {
        if (time - enemy.lastShotAt >= (enemy.kind === "boss" ? 1250 : 1650)) {
          enemy.lastShotAt = time;
          this.fireEnemyShot(enemy);
        }
        if (enemy.kind === "hidden" && playerDistance > 260) this.physics.moveTo(enemy.sprite, this.player.x, this.player.y, enemy.speed);
        else enemy.sprite.setVelocity(0);
      } else if (playerDistance <= 470) {
        this.physics.moveTo(enemy.sprite, this.player.x, this.player.y, enemy.speed);
      } else {
        this.physics.moveTo(enemy.sprite, enemy.spawnX, enemy.spawnY, enemy.speed);
      }

      if (playerDistance <= 34 && time - enemy.lastAttackAt >= 850) {
        enemy.lastAttackAt = time;
        this.damagePlayer(enemy.damage);
      }
      const clamped = clampToRoom(enemy.sprite.x, enemy.sprite.y, 22);
      enemy.sprite.setPosition(clamped.x, clamped.y);
    }
  }

  private fireEnemyShot(enemy: LocalEnemy): void {
    const startX = enemy.sprite.x;
    const startY = enemy.sprite.y;
    const targetX = this.player.x;
    const targetY = this.player.y;
    this.roomRenderer.showAttack(startX, startY, targetX, targetY, enemy.kind === "boss" ? 0xff5f9f : 0xd88cff);
    this.time.delayedCall(260, () => {
      if (!enemy.sprite.active || this.ended) return;
      if (Phaser.Math.Distance.Between(this.player.x, this.player.y, targetX, targetY) <= 52) this.damagePlayer(enemy.damage);
    });
  }

  private damageEnemy(enemy: LocalEnemy, damage: number): void {
    if (!enemy.sprite.active) return;
    enemy.engaged = true;
    enemy.hp -= damage;
    this.stats.damage += damage;
    if (enemy.kind === "boss") this.stats.bossDamage += damage;
    enemy.sprite.setTintFill(0xffffff);
    this.time.delayedCall(55, () => enemy.sprite.active && enemy.sprite.clearTint());
    if (enemy.hp <= 0) this.killEnemy(enemy);
  }

  private killEnemy(enemy: LocalEnemy): void {
    const x = enemy.sprite.x;
    const y = enemy.sprite.y;
    enemy.sprite.disableBody(true, true);
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
    this.roomRenderer.showWaypoint(this.currentZone === 3 ? "마왕전 진입 웨이포인트" : "다음 구역 웨이포인트");
    this.message = "게이트 파괴 완료 · 웨이포인트 위에서 집결 명령을 사용하세요.";
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
    const bossRoom: RenderableRoom = { id: "boss", zone: 3, x: 4, y: 0, type: "boss", connections: [] };
    this.roomRenderer.renderRoom(bossRoom, [], { showBuildGrid: false, waypointActive: false });
    this.player.setPosition(640, 580);
    this.spawnEnemy("boss", 640, 300, 3);
    this.message = "마왕전 개시 · 조준점 방향으로 공격을 집중하세요.";
  }

  private checkDoorTransition(time: number): void {
    if (time < this.transitionReadyAt || this.currentRoomId === "boss") return;
    if (this.enemies.some((enemy) => enemy.sprite.active)) return;
    for (const door of this.currentDoors) {
      const touching = door.direction === "north"
        ? this.player.y <= ROOM_VIEW.top + 25 && Math.abs(this.player.x - door.x) <= ROOM_VIEW.doorHalfSize
        : door.direction === "south"
          ? this.player.y >= ROOM_VIEW.bottom - 25 && Math.abs(this.player.x - door.x) <= ROOM_VIEW.doorHalfSize
          : door.direction === "east"
            ? this.player.x >= ROOM_VIEW.right - 25 && Math.abs(this.player.y - door.y) <= ROOM_VIEW.doorHalfSize
            : this.player.x <= ROOM_VIEW.left + 25 && Math.abs(this.player.y - door.y) <= ROOM_VIEW.doorHalfSize;
      const pressing = door.direction === "north" ? this.keys.W.isDown
        : door.direction === "south" ? this.keys.S.isDown
          : door.direction === "east" ? this.keys.D.isDown : this.keys.A.isDown;
      if (!touching || !pressing) continue;
      const source = this.currentRoomId;
      this.transitionReadyAt = time + 350;
      this.enterLocalRoom(door.destinationId, source);
      return;
    }
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
    this.enterLocalRoom(this.worldMap.zones[0].startRoomId, null);
    this.message = `귀환 완료 · ${previous}에서 베이스로 이동했습니다.`;
  }

  private damagePlayer(rawDamage: number): void {
    const damage = Math.max(1, Math.round(rawDamage - this.effectiveDefense()));
    this.progression.stats.hp -= damage;
    this.player.setTintFill(0xff7e9e);
    this.time.delayedCall(65, () => this.player.active && this.player.clearTint());
    if (this.progression.stats.hp <= 0) {
      this.stats.deaths += 1;
      this.finishGame("defeat", "용사가 쓰러져 원정이 끝났습니다.");
    }
  }

  private damageBase(rawDamage: number): void {
    this.baseHp -= Math.max(1, Math.round(rawDamage));
    if (this.baseHp <= 0) this.finishGame("defeat", "베이스캠프가 파괴되었습니다.");
  }

  private handleCommand(command: GameCommand): void {
    if (command.type === "choose-upgrade") {
      if (this.options.networked) {
        const draftId = this.latestNetwork?.localUpgradeDraft?.draftId;
        if (draftId) colyseusTransport.chooseUpgrade(draftId, command.upgradeId);
      } else {
        this.chooseUpgrade(command.upgradeId);
      }
    } else if (command.type === "set-build-mode") {
      if (!this.options.networked && this.isLocalBuildRoom() && isInsideBuildBounds(this.player.x, this.player.y)) {
        this.buildMode = command.buildMode;
      }
    } else if (command.type === "travel") {
      if (this.options.networked) colyseusTransport.requestTravel(command.waypointId, command.destinationId);
      else this.requestWaypointAction(this.isNearGateWaypoint() ? "advance" : "recall");
    } else if (command.type === "interact") {
      if (this.options.networked) colyseusTransport.interact(command.targetId);
    } else if (command.type === "return-base") {
      if (this.options.networked) colyseusTransport.requestRecall();
      else if (this.localPhase !== "boss") this.requestWaypointAction("recall");
    } else if (command.type === "enter-boss" && !this.options.networked && this.currentZone === 3 && this.isNearGateWaypoint()) {
      this.requestWaypointAction("advance");
    }
  }

  private renderNetworkPlaceholder(): void {
    const room = this.worldMap.zones[0].rooms.find((candidate) => candidate.id === this.worldMap.zones[0].startRoomId) as ZoneRoom;
    this.roomRenderer.renderRoom(room, doorLayouts(room, this.worldMap.zones[0].rooms), { showBuildGrid: false, waypointActive: false });
    this.message = "서버 방 상태를 기다리는 중입니다.";
  }

  private renderNetworkRoom(snapshot: NetworkWorldSnapshot, local: PartyMemberSnapshot): void {
    const serverRoom = snapshot.rooms.find((room) => room.id === local.roomId);
    const fallbackZone = this.worldMap.zones[this.currentZone - 1];
    const fallbackRoom = fallbackZone.rooms.find((room) => room.id === local.roomId) ?? fallbackZone.rooms[0];
    const room: RenderableRoom = serverRoom
      ? { ...serverRoom, connections: serverRoom.connections }
      : fallbackRoom;
    const roomPool: RenderableRoom[] = snapshot.rooms.length > 0
      ? snapshot.rooms.filter((candidate) => candidate.zone === room.zone).map((candidate) => ({ ...candidate, connections: candidate.connections }))
      : [...fallbackZone.rooms];
    this.currentDoors = doorLayouts(room, roomPool);
    const waypointActive = snapshot.waypoints.some((waypoint) => waypoint.roomId === room.id && waypoint.active);
    this.roomRenderer.renderRoom(room, this.currentDoors, {
      showBuildGrid: room.type === "start" && room.zone === 1,
      waypointActive,
    });
  }

  private syncNetworkPlayers(players: PartyMemberSnapshot[], localRoomId: string): void {
    const activeIds = new Set(players.map((member) => member.userId));
    for (const [userId, sprite] of this.remotePlayers) {
      if (!activeIds.has(userId)) {
        sprite.destroy();
        this.remotePlayers.delete(userId);
      }
    }
    for (const member of players) {
      const isLocal = member.isLocal || member.userId === this.options.userId;
      const sprite = isLocal
        ? this.player
        : this.remotePlayers.get(member.userId) ?? this.roomRenderer.createHero(member.heroClass, member.x, member.y, 0.82);
      if (!isLocal && !this.remotePlayers.has(member.userId)) this.remotePlayers.set(member.userId, sprite);
      const point = clampToRoom(member.x, member.y);
      sprite.setPosition(point.x, point.y).setVisible(member.roomId === localRoomId && member.connected).setActive(member.connected);
      sprite.setAlpha(isLocal ? 1 : 0.82);
    }
  }

  private syncNetworkEnemies(snapshot: NetworkWorldSnapshot, localRoomId: string): void {
    const enemies = snapshot.enemies;
    const activeIds = new Set(enemies.map((enemy) => enemy.id));
    for (const [id, sprite] of this.networkEnemies) {
      if (!activeIds.has(id)) {
        sprite.destroy();
        this.networkEnemies.delete(id);
      }
    }
    for (const enemy of enemies) {
      const kind: LocalEnemyKind = enemy.kind === "boss" || enemy.behavior === "boss" ? "boss"
        : enemy.kind === "gate" || enemy.behavior === "gate" ? "gate"
          : enemy.kind === "hidden" || enemy.kind === "hidden-ranged" || enemy.behavior === "hidden" ? "hidden"
            : enemy.kind === "invader" || enemy.behavior === "invader" ? "invader" : "static";
      const sprite = this.networkEnemies.get(enemy.id) ?? this.roomRenderer.createEnemy(kind, enemy.x, enemy.y);
      if (!this.networkEnemies.has(enemy.id)) this.networkEnemies.set(enemy.id, sprite);
      const point = clampToRoom(enemy.x, enemy.y);
      sprite.setPosition(point.x, point.y).setVisible(enemy.roomId === localRoomId && enemy.alive).setActive(enemy.alive);
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
          colyseusTransport.equip(drop.id);
          this.message = `${drop.rarity === "mythic" ? "신화" : "전설"} 개인 장비 교체를 요청했습니다.`;
          this.emitSnapshot();
        });
        this.networkDrops.set(drop.id, object);
      }
      object.setPosition(drop.x, drop.y).setVisible(true).setActive(true);
    }
  }

  private emitSnapshot(): void {
    const snapshot = this.options.networked ? this.createNetworkGameSnapshot() : this.createLocalGameSnapshot();
    gameBridge.emit("snapshot", snapshot);
  }

  private createLocalGameSnapshot(): GameSnapshot {
    const roomMap = this.localRoomMap();
    const currentRoom = this.currentRoom();
    const waypointNearby = this.isNearActiveWaypoint();
    const advancesZone = currentRoom?.type === "gate" && this.clearedGateZones.has(this.currentZone);
    const destinationId = advancesZone
      ? this.currentZone === 3 ? "boss" : this.worldMap.zones[this.currentZone].startRoomId
      : this.worldMap.zones[0].startRoomId;
    const equipped = [...this.equipment.values()].map((item) => item.summary);
    const teamPower = this.progression.powerScore + equipped.reduce((sum, item) => sum + item.power, 0);
    const boss = this.boss?.sprite.active ? this.boss : null;
    return {
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
      gatesDestroyed: this.clearedGateZones.size,
      buildMode: this.buildMode,
      qCooldown: Math.max(0, (this.qReadyAt - this.time.now) / 1000),
      eCooldown: Math.max(0, (this.eReadyAt - this.time.now) / 1000),
      dashCooldown: Math.max(0, (this.dashReadyAt - this.time.now) / 1000),
      bossAvailable: this.currentZone === 3 && this.clearedGateZones.has(3) && this.currentRoom()?.type === "gate",
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
        alive: this.progression.stats.hp > 0,
        roomId: this.currentRoomId,
        x: this.player.x,
        y: this.player.y,
        isLocal: true,
      }],
      currentZone: this.currentZone,
      currentRoomId: this.currentRoomId,
      roomsExplored: roomMap.filter((room) => room.zone === this.currentZone && room.visited).length,
      roomMap,
      equipment: equipped,
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
    const waypointNearby = Boolean(activeWaypoint && local && Phaser.Math.Distance.Between(local.x, local.y, 640, 360) <= 95);
    const destinationWaypoint = state?.waypoints.find((waypoint) => waypoint.id === activeWaypoint?.destinationId);
    const destinationRoomId = destinationWaypoint?.roomId ?? activeWaypoint?.destinationId;
    const waypointDestination = roomMap.find((room) => room.id === destinationRoomId);
    const connectedAlivePlayers = state?.players.filter((member) => member.connected && member.alive).length ?? 1;
    const requiredPlayers = activeWaypoint && activeWaypoint.requiredPlayers > 0
      ? activeWaypoint.requiredPlayers
      : this.options.partyMode === "solo" ? 1 : Math.max(1, connectedAlivePlayers);
    return {
      running: phase !== "ended",
      phase,
      phaseLabel: PHASE_LABELS[phase],
      day: state?.day ?? 1,
      phaseRemaining: remaining,
      elapsed: state?.elapsed ?? 0,
      hp: local?.hp ?? 0,
      maxHp: local?.maxHp ?? 0,
      baseHp: state?.baseHp ?? 0,
      baseMaxHp: state?.baseMaxHp ?? BASE_MAX_HP,
      level: state?.teamLevel ?? local?.level ?? 1,
      xp: state?.teamXp ?? 0,
      xpToNext: state?.teamXpToNext ?? 0,
      gold: state?.gold ?? 0,
      teamPower: state?.players.reduce((sum, member) => sum + member.teamPower, 0) ?? 0,
      gatesDestroyed: roomMap.filter((room) => room.type === "gate" && room.cleared).length,
      buildMode: this.buildMode,
      qCooldown: 0,
      eCooldown: 0,
      dashCooldown: 0,
      bossAvailable: currentRoom?.type === "gate" && currentRoom.zone === 3 && currentRoom.cleared,
      bossHp: boss?.hp ?? null,
      bossMaxHp: boss?.maxHp ?? null,
      message: this.message,
      upgrades: [],
      stats: { ...(state?.stats ?? this.stats) },
      party: state?.players ?? [],
      currentZone: state?.currentZone ?? 1,
      currentRoomId: local?.roomId ?? this.currentRoomId,
      roomsExplored: roomMap.filter((room) => room.zone === (state?.currentZone ?? 1) && room.visited).length,
      roomMap,
      equipment: state?.localEquipment ?? [],
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

  private localRoomMap(): RoomMapCell[] {
    return this.worldMap.zones.flatMap((zone) => zone.rooms.map((room): RoomMapCell => ({
      id: room.id,
      zone: room.zone,
      x: room.x,
      y: room.y,
      type: room.type,
      visited: this.visitedRooms.has(room.id),
      current: room.id === this.currentRoomId,
      cleared: this.clearedRooms.has(room.id),
      connections: [...room.connections],
    })));
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
    for (const enemy of this.enemies) enemy.sprite.destroy();
    for (const drop of this.drops) drop.object.destroy();
    for (const drop of this.networkDrops.values()) drop.destroy();
    this.enemies = [];
    this.drops = [];
    this.networkDrops.clear();
    this.networkDropRequests.clear();
    this.boss = null;
  }

  private zoneMap() {
    return this.worldMap.zones[this.currentZone - 1];
  }

  private currentRoom(): ZoneRoom | undefined {
    if (this.currentRoomId === "boss") return undefined;
    return this.zoneMap().rooms.find((room) => room.id === this.currentRoomId);
  }

  private isLocalBuildRoom(): boolean {
    const room = this.currentRoom();
    return room?.zone === 1 && room.type === "start";
  }

  private isNearGateWaypoint(): boolean {
    const room = this.currentRoom();
    return Boolean(room?.type === "gate" && this.clearedGateZones.has(room.zone)
      && Phaser.Math.Distance.Between(this.player.x, this.player.y, 640, 360) <= 95);
  }

  private isNearActiveWaypoint(): boolean {
    const room = this.currentRoom();
    const active = room?.type === "start"
      || room?.type === "central-waypoint"
      || (room?.type === "gate" && this.clearedGateZones.has(room.zone));
    return Boolean(active && Phaser.Math.Distance.Between(this.player.x, this.player.y, 640, 360) <= 95);
  }

  private aimAngle(): number {
    const pointer = this.input.activePointer;
    return Phaser.Math.Angle.Between(this.player.x, this.player.y, pointer.worldX, pointer.worldY);
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

  private effectiveDefense(): number {
    return this.progression.stats.defense + (this.equipment.get("armor")?.defenseBonus ?? 0);
  }

  private effectiveAttackInterval(): number {
    return Math.max(110, Math.round(this.progression.stats.attackIntervalMs * (1 - (this.equipment.get("accessory")?.attackSpeedPercent ?? 0) / 100)));
  }

  private cleanup(): void {
    this.commandDisconnect?.();
    this.networkDisconnect?.();
    this.commandDisconnect = undefined;
    this.networkDisconnect = undefined;
    this.input.removeAllListeners();
    for (const sprite of this.remotePlayers.values()) sprite.destroy();
    for (const sprite of this.networkEnemies.values()) sprite.destroy();
    for (const drop of this.networkDrops.values()) drop.destroy();
    this.remotePlayers.clear();
    this.networkEnemies.clear();
    this.networkDrops.clear();
    this.networkDropRequests.clear();
    this.roomRenderer?.destroy();
  }
}

function normalizeZone(value: number): ZoneId {
  if (value === 2 || value === 3) return value;
  return 1;
}
