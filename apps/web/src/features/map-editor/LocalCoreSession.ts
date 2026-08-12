import {
  GameCore,
  MINIMAP_VISION_RADIUS,
  boundarySegments,
  boundsOf,
  createExplorationMask,
  createCoreViewSnapshot,
  createMiniMapGrid,
  equipmentPower,
  rectToMiniMapSurface,
  revealRoomRect,
  type CorePlayer,
  type CoreWorldDefinition,
} from "@five-days/game-core";
import { PROTOCOL_VERSION, type InputFrame, type WorldFrame } from "@five-days/protocol";
import type {
  EquipmentSummary,
  MiniMapSnapshot,
  NetworkWorldSnapshot,
  PartyMemberSnapshot,
  UpgradeChoice,
} from "../../game/domain/types";

const STEP_MS = 1_000 / 60;
const AI_PLAYERS = [
  { userId: "ai:editor-defender", displayName: "루엔", heroClass: "archer" as const },
  { userId: "ai:editor-follower", displayName: "세라", heroClass: "mage" as const },
] as const;

export type LocalCoreInput = Readonly<{ x: number; y: number; aim: number; buttons: number }>;

export class LocalCoreSession {
  private core: GameCore | null = null;
  private world: CoreWorldDefinition | null = null;
  private localUserId = "";
  private inputSeq = 0;
  private serverTick = 0;
  private accumulatorMs = 0;
  private minimap: MiniMapSnapshot | null = null;
  private minimapAccumulatorMs = 0;
  private readonly revealedRoomIds = new Set<string>();
  private readonly previousFrameTransforms = new Map<string, { x: number; y: number; at: number }>();

  start(world: CoreWorldDefinition, localUserId: string): NetworkWorldSnapshot {
    this.stop();
    this.world = world;
    this.localUserId = localUserId;
    this.core = new GameCore({
      mode: "prototype",
      difficulty: "normal",
      seed: `editor-core:${world.id}`,
      minimumPlayers: 3,
      world,
    });
    const players = [
      { userId: localUserId, displayName: "나", heroClass: "swordsman" as const },
      ...AI_PLAYERS,
    ];
    for (const player of players) this.core.addPlayer(player);
    for (const player of players) this.core.setReady(player.userId, true);
    this.minimap = createEditorMinimap(world, this.core);
    this.revealPartyExploration();
    return this.snapshot();
  }

  stop(): void {
    this.core = null;
    this.world = null;
    this.localUserId = "";
    this.inputSeq = 0;
    this.serverTick = 0;
    this.accumulatorMs = 0;
    this.minimap = null;
    this.minimapAccumulatorMs = 0;
    this.revealedRoomIds.clear();
    this.previousFrameTransforms.clear();
  }

  tick(deltaMs: number, input: LocalCoreInput): { snapshot: NetworkWorldSnapshot; frame: WorldFrame; inputFrame: InputFrame; message?: string } {
    const core = this.requireCore();
    const inputFrame: InputFrame = {
      v: PROTOCOL_VERSION,
      seq: this.inputSeq++,
      clientTime: performance.now(),
      ...input,
    };
    core.applyInput(this.localUserId, {
      v: PROTOCOL_VERSION,
      type: "player.input",
      seq: inputFrame.seq,
      clientTime: inputFrame.clientTime,
      payload: input,
    });
    this.accumulatorMs += Math.min(100, Math.max(0, deltaMs));
    let steps = 0;
    while (this.accumulatorMs >= STEP_MS && steps < 6) {
      core.update(STEP_MS / 1_000);
      this.accumulatorMs -= STEP_MS;
      this.serverTick += 1;
      steps += 1;
    }
    // Editor rendering recovers attacks from the snapshot sequence; drain the
    // reliable server-only event queue so a long local playtest stays bounded.
    core.takeCombatAttackEvents();
    this.minimapAccumulatorMs += Math.min(100, Math.max(0, deltaMs));
    if (this.minimapAccumulatorMs >= 100) {
      this.minimapAccumulatorMs %= 100;
      this.revealPartyExploration();
    }
    const message = core.takeNotices().find((notice) => notice.userId === null || notice.userId === this.localUserId)?.message;
    return { snapshot: this.snapshot(), frame: this.worldFrame(inputFrame.seq), inputFrame, ...(message ? { message } : {}) };
  }

  chooseUpgrade(draftId: string, upgradeId: UpgradeChoice["id"]): boolean {
    return this.requireCore().chooseUpgrade(this.localUserId, draftId, upgradeId);
  }

  equip(dropId: string): boolean {
    return this.requireCore().equipDrop(this.localUserId, dropId);
  }

  recall(): boolean {
    return this.requireCore().recall(this.localUserId);
  }

  interact(targetId: string): boolean {
    return this.requireCore().interact(this.localUserId, targetId);
  }

  requestTravel(waypointId: string, destinationId: string): boolean {
    return this.requireCore().requestTravel(this.localUserId, waypointId, destinationId);
  }

  specialCommand(type: string, payload: Record<string, string | number> = {}): boolean {
    const core = this.requireCore();
    if (type === "equipment.inventory-equip") return core.equipInventoryItem(this.localUserId, Number(payload.inventoryIndex));
    if (type === "equipment.inventory-discard") return core.discardInventoryItem(this.localUserId, Number(payload.inventoryIndex));
    if (type === "shrine.claim") return core.claimShrine(this.localUserId);
    if (type === "checkpoint.set") return core.setCheckpoint(this.localUserId);
    if (type === "altar.reroll") return core.rerollAltar(this.localUserId) !== null;
    return false;
  }

  private snapshot(): NetworkWorldSnapshot {
    const core = this.requireCore();
    const view = createCoreViewSnapshot(core);
    const local = core.players.get(this.localUserId);
    const players = view.players.map((player) => playerSnapshot(core, player, player.userId === this.localUserId));
    const rooms = view.rooms.map((room) => ({
      id: room.id,
      zone: room.zone,
      x: room.gridX,
      y: room.gridY,
      type: room.kind,
      visited: room.discovered,
      current: room.id === local?.roomId,
      cleared: room.cleared,
      connections: [...room.connections],
    }));
    const draft = local?.upgradeDraft;
    const now = Date.now();
    return {
      matchId: "editor-local-core",
      seed: core.options.seed,
      phase: view.phase,
      resultState: view.result,
      resultReason: view.resultReason,
      day: view.day,
      serverTime: now,
      elapsed: view.elapsed,
      phaseEndsAt: view.phaseRemaining > 0 ? now + view.phaseRemaining * 1_000 : 0,
      baseHp: view.baseHp,
      baseMaxHp: view.baseMaxHp,
      currentZone: view.currentZone,
      teamLevel: view.teamLevel,
      teamXp: view.teamXp,
      teamXpToNext: view.teamXpToNext,
      players,
      rooms,
      enemies: view.enemies.map((enemy) => ({
        id: enemy.id,
        kind: enemy.kind,
        behavior: enemy.behavior,
        roomId: enemy.roomId,
        spawnRoomId: enemy.spawnRoomId,
        targetId: enemy.targetId ?? "",
        x: enemy.x,
        y: enemy.y,
        hp: enemy.hp,
        maxHp: enemy.maxHp,
        alive: enemy.alive,
        patternKind: enemy.patternKind,
        patternPhase: enemy.patternPhase,
        patternRemaining: enemy.patternRemaining,
        patternIndex: enemy.patternIndex,
        attackSequence: enemy.attackSequence,
      })),
      drops: view.drops.filter((drop) => drop.ownerPlayerId === this.localUserId && !drop.claimed).map((drop) => ({
        id: drop.id,
        ownerUserId: drop.ownerPlayerId,
        roomId: drop.roomId,
        slot: drop.slot,
        rarity: drop.rarity,
        x: drop.x,
        y: drop.y,
        specialOptionCount: drop.specialOptionCount,
      })),
      waypoints: view.waypoints.map((waypoint) => ({
        id: waypoint.id,
        roomId: waypoint.roomId,
        kind: waypoint.kind,
        destinationId: waypoint.destinationId,
        active: waypoint.active,
        requiredPlayers: waypoint.requiredPlayers,
        holdingPlayers: waypoint.holdingPlayers,
        holdProgress: waypoint.holdProgress,
        holdDurationMs: waypoint.holdDurationMs,
      })),
      waypointHoldProgress: Math.max(0, ...view.waypoints.map((waypoint) => waypoint.holdProgress)),
      localUpgradeDraft: draft ? {
        draftId: draft.draftId,
        level: draft.level,
        choices: draft.choices.map((choice) => ({
          id: choice.id,
          name: choice.name,
          description: choice.description ?? "",
          tag: choice.classId === "swordsman" ? "검사" : choice.classId === "archer" ? "궁수" : choice.classId === "mage" ? "마법사" : "공용",
          classId: choice.classId,
          maxStacks: choice.maxStacks,
          rarity: choice.rarity,
          stack: local?.upgrades[choice.id] ?? 0,
        })),
      } : null,
      stats: {
        damage: [...core.players.values()].reduce((sum, player) => sum + player.damage, 0),
        bossDamage: [...core.players.values()].reduce((sum, player) => sum + player.bossDamage, 0),
        kills: [...core.players.values()].reduce((sum, player) => sum + player.kills, 0),
        deaths: [...core.players.values()].reduce((sum, player) => sum + player.deaths, 0),
        structuresBuilt: [...core.players.values()].reduce((sum, player) => sum + player.structuresBuilt, 0),
        gatesDestroyed: [...core.players.values()].reduce((sum, player) => sum + player.gatesDestroyed, 0),
      },
      minimap: this.minimap,
      specialRooms: view.specialRooms.map((entry) => ({
        roomId: entry.roomId, kind: entry.kind, shrineKind: entry.shrineKind ?? "", shrineClaimedBy: entry.shrineClaimedBy ?? "",
        shrineClaimingBy: entry.shrineClaimingBy ?? "", shrineClaimProgress: entry.shrineClaimProgress ?? 0,
        trapPhase: entry.trapPhase ?? "", trapDebuff: entry.trapDebuff ?? "",
        trapParticipants: [...(entry.trapParticipants ?? [])],
      })),
    };
  }

  private worldFrame(ackInputSeq: number): WorldFrame {
    const core = this.requireCore();
    const now = Date.now();
    const sample = (entity: { id: string; roomId: string; x: number; y: number; aim?: number }) => {
      const previous = this.previousFrameTransforms.get(entity.id);
      const elapsedSeconds = previous ? Math.max(0.001, (now - previous.at) / 1_000) : 0;
      const vx = previous ? (entity.x - previous.x) / elapsedSeconds : 0;
      const vy = previous ? (entity.y - previous.y) / elapsedSeconds : 0;
      this.previousFrameTransforms.set(entity.id, { x: entity.x, y: entity.y, at: now });
      return {
        id: entity.id,
        roomId: entity.roomId,
        x: entity.x,
        y: entity.y,
        vx,
        vy,
        aim: entity.aim ?? (vx !== 0 || vy !== 0 ? Math.atan2(vy, vx) : 0),
        flags: 0,
      };
    };
    return {
      v: PROTOCOL_VERSION,
      serverTick: this.serverTick,
      serverTime: now,
      ackInputSeq,
      players: [...core.players.values()].map((player) => sample({ id: player.userId, ...player })),
      enemies: [...core.enemies.values()].filter((enemy) => enemy.alive && core.discoveredRooms.has(enemy.roomId)).map((enemy) => sample(enemy)),
    };
  }

  private revealPartyExploration(): void {
    if (!this.minimap) return;
    const core = this.requireCore();
    let changed = false;
    for (const roomId of core.discoveredRooms) {
      if (this.revealedRoomIds.has(roomId)) continue;
      this.revealedRoomIds.add(roomId);
      if (revealRoomRect(this.minimap.geometry, this.minimap.explorationMask, core.roomRectOf(roomId)).length > 0) changed = true;
    }
    if (changed) this.minimap.revision += 1;
  }

  private requireCore(): GameCore {
    if (!this.core) throw new Error("LocalCoreSession이 시작되지 않았습니다.");
    return this.core;
  }
}

function playerSnapshot(core: GameCore, player: CorePlayer, isLocal: boolean): PartyMemberSnapshot {
  const equipment = Object.entries(player.equipment)
    .filter((entry): entry is [EquipmentSummary["slot"], NonNullable<typeof entry[1]>] => Boolean(entry[1]))
    .map(([slot, item]) => ({ slot, name: item.id, rarity: item.rarity, power: equipmentPower(item) }));
  return {
    userId: player.userId,
    displayName: player.displayName,
    heroClass: player.heroClass,
    hp: player.hp,
    maxHp: player.maxHp,
    level: player.level,
    teamPower: player.teamPower,
    ready: player.ready,
    connected: player.connected,
    alive: player.alive,
    respawnRemaining: player.respawnRemaining,
    roomId: player.roomId,
    x: player.x,
    y: player.y,
    aim: player.aim,
    attackSequence: player.attackCount,
    attackTargetId: player.lastAttackTargetId ?? "",
    attackCritical: player.lastAttackCritical,
    isLocal,
    equipment,
    inventory: player.inventory.map((item) => item ? ({ id: item.id, slot: item.slot, rarity: item.rarity }) : null),
    respawnRoomId: player.respawnRoomId,
    altarAttempts: player.altarAttempts,
    shrineBuff: player.shrineBuff?.kind ?? "",
    shrineBuffRemaining: player.shrineBuff ? Math.max(0, player.shrineBuff.expiresAt - core.elapsed) : 0,
  };
}

function createEditorMinimap(world: CoreWorldDefinition, core: GameCore): MiniMapSnapshot {
  const bounds = boundsOf(world.walkable);
  const grid = createMiniMapGrid(bounds);
  const wallSegments = boundarySegments(world.walkable);
  const geometry = {
    mapRevision: `${world.id}:v1`,
    areaId: "editor",
    bounds,
    ...grid,
    surfaces: world.walkable.map((rect, index) => rectToMiniMapSurface(rect, `editor:surface:${index}`)),
    wallSegments,
    visionRadius: MINIMAP_VISION_RADIUS,
    markers: [
      ...world.rooms.flatMap((room) => {
      const kind: "resource" | "monster" | "elite" | null = room.kind === "resource"
        ? "resource"
        : room.kind === "static-monster" ? "monster" : room.kind === "hidden-monster" ? "elite" : null;
      return kind ? [{
        id: `room-marker:${room.id}`,
        roomId: room.id,
        kind,
        label: kind === "resource" ? "자원 방" : kind === "elite" ? "정예 몬스터 방" : "몬스터 방",
        x: room.rect.x + room.rect.width / 2,
        y: room.rect.y + room.rect.height / 2,
        areaId: "editor",
        active: true,
      }] : [];
      }),
      ...[...core.waypoints.values()].map((waypoint) => ({
        id: waypoint.id,
        roomId: waypoint.roomId,
        kind: waypoint.kind === "boss" ? "boss" as const : waypoint.kind === "gate" ? "gate" as const : "waypoint" as const,
        label: waypoint.kind === "boss" ? "마왕의 제단" : waypoint.kind === "gate" ? "구역 게이트" : "웨이포인트",
        x: waypoint.x,
        y: waypoint.y,
        areaId: "editor",
        active: waypoint.active,
      })),
    ],
  };
  return { geometry, explorationMask: createExplorationMask(geometry), revision: 0 };
}

export const localCoreSession = new LocalCoreSession();
