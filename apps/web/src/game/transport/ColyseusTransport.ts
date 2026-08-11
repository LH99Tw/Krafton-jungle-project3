import { Client, type Room } from "colyseus.js";
import {
  PARTY_ROOM,
  PROTOCOL_VERSION,
  combatAttackEventSchema,
  fastLaneOfferSchema,
  minimapDeltaSchema,
  minimapInitSchema,
  worldFrameSchema,
  type FastLaneOffer,
  type InputFrame,
  type RoomOptions,
  type TransportMode,
} from "@five-days/protocol";
import { normalizeAimAngle } from "../netcode/aim";
import { applyCellRanges, decodeMask, OFFICIAL_MAP_MANIFEST } from "@five-days/game-core";
import type {
  HeroClassId,
  EquipmentSummary,
  NetworkDropSnapshot,
  NetworkEnemySnapshot,
  NetworkWorldSnapshot,
  MiniMapSnapshot,
  PartyMemberSnapshot,
  RoomMapCell,
  TeamStats,
  UpgradeChoice,
  UpgradeId,
} from "../domain/types";
import { gameBridge } from "../runtime/GameBridge";
import { ClientPartyExploration, type ExplorationActor } from "../netcode/ClientPartyExploration";

export type NetworkStatus = "idle" | "connecting" | "waiting" | "connected" | "reconnecting" | "disconnected" | "error";

type TicketResponse = { token: string; expiresAt: string };
type StateListener = (state: NetworkWorldSnapshot) => void;
type TransportEvent = {
  type: string;
  message?: string;
  code?: string;
  state?: string;
  elapsed?: number;
  day?: number;
  level?: number;
  teamPower?: number;
  stats?: Partial<TeamStats>;
};
type EventListener = (event: TransportEvent) => void;

type SchemaCollection<T> = {
  forEach(callback: (value: T, key: string | number) => void): void;
};

type PlayerStateLike = {
  userId?: string;
  displayName?: string;
  heroClass?: string;
  hp?: number;
  maxHp?: number;
  level?: number;
  teamPower?: number;
  attackDamage?: number;
  defense?: number;
  criticalChance?: number;
  criticalDamage?: number;
  attacksPerSecond?: number;
  attackRange?: number;
  moveSpeed?: number;
  qCooldown?: number;
  eCooldown?: number;
  skillSequence?: number;
  lastSkillId?: string;
  skillTargetX?: number;
  skillTargetY?: number;
  skillRadius?: number;
  damage?: number;
  bossDamage?: number;
  kills?: number;
  deaths?: number;
  structuresBuilt?: number;
  goldSpent?: number;
  gatesDestroyed?: number;
  ready?: boolean;
  connected?: boolean;
  alive?: boolean;
  roomId?: string;
  aim?: number;
  attackSequence?: number;
  attackTargetId?: string;
  attackCritical?: boolean;
  x?: number;
  y?: number;
  upgradeDraft?: {
    draftId?: string;
    level?: number;
    active?: boolean;
    choices?: SchemaCollection<{
      upgradeId?: string;
      name?: string;
      description?: string;
      rarity?: string;
      stack?: number;
      maxStacks?: number;
      order?: number;
    }>;
  };
  equipment?: {
    weaponId?: string;
    weaponRarity?: string;
    armorId?: string;
    armorRarity?: string;
    accessoryId?: string;
    accessoryRarity?: string;
    attackBonus?: number;
    maxHpBonus?: number;
    defenseBonus?: number;
    attackSpeedBonus?: number;
  };
};

type RoomStateLike = {
  id?: string;
  zone?: number;
  x?: number;
  y?: number;
  gridX?: number;
  gridY?: number;
  roomType?: string;
  kind?: string;
  visited?: boolean;
  discovered?: boolean;
  cleared?: boolean;
  connections?: SchemaCollection<string> | string[];
};

type DoorStateLike = { fromRoomId?: string; toRoomId?: string };
type WaypointStateLike = {
  id?: string;
  roomId?: string;
  kind?: string;
  destinationId?: string;
  active?: boolean;
  requiredPlayers?: number;
  holdingPlayers?: number;
  holdProgress?: number;
  holdDurationMs?: number;
};
type EnemyStateLike = {
  id?: string;
  kind?: string;
  behavior?: string;
  roomId?: string;
  spawnRoomId?: string;
  targetId?: string;
  x?: number;
  y?: number;
  hp?: number;
  maxHp?: number;
  alive?: boolean;
  patternKind?: string;
  patternPhase?: string;
  patternRemaining?: number;
  patternIndex?: number;
  attackSequence?: number;
};
type DropStateLike = {
  id?: string;
  ownerUserId?: string;
  roomId?: string;
  slot?: string;
  rarity?: string;
  x?: number;
  y?: number;
  specialOptionCount?: number;
  claimed?: boolean;
};

type PartyStateLike = {
  matchId?: string;
  seed?: string;
  phase?: string;
  resultState?: string;
  resultReason?: string;
  day?: number;
  serverTime?: number;
  elapsed?: number;
  phaseEndsAt?: number;
  baseHp?: number;
  baseMaxHp?: number;
  gold?: number;
  currentZone?: number;
  teamLevel?: number;
  teamXp?: number;
  teamXpToNext?: number;
  waypointHoldProgress?: number;
  players?: SchemaCollection<PlayerStateLike>;
  rooms?: SchemaCollection<RoomStateLike>;
  doors?: SchemaCollection<DoorStateLike>;
  waypoints?: SchemaCollection<WaypointStateLike>;
  enemies?: SchemaCollection<EnemyStateLike>;
  drops?: SchemaCollection<DropStateLike>;
};

class ColyseusTransport {
  private client: Client | null = null;
  private room: Room | null = null;
  private generation = 0;
  private reconnecting = false;
  private terminal = false;
  private reliableSeq = 0;
  private inputSeq = 0;
  private readonly pendingInputs = new Map<number, InputFrame>();
  private inputTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pressed = new Set<string>();
  private aim = 0;
  private cleanupInput: (() => void) | null = null;
  private readonly stateListeners = new Set<StateListener>();
  private readonly eventListeners = new Set<EventListener>();
  private latestState: NetworkWorldSnapshot | null = null;
  private readonly minimaps = new Map<string, MiniMapSnapshot>();
  private readonly clientExploration = new ClientPartyExploration();
  private lastExplorationPublishAt = 0;
  private localUserId = "";
  private fastLane: WebTransport | null = null;
  private fastLaneWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private transportModeValue: TransportMode = "websocket-fallback";
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private rendererReady = false;
  private readySent = false;

  async connect(input: {
    serverUrl: string;
    csrfToken: string;
    userId: string;
    options: Omit<RoomOptions, "protocolVersion" | "mapRevision">;
    roomId?: string;
  }): Promise<NetworkWorldSnapshot | null> {
    this.disconnect();
    const generation = this.generation;
    this.terminal = false;
    this.localUserId = input.userId;
    const ticketResponse = await fetch("/api/game-ticket", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": input.csrfToken },
      body: JSON.stringify({ room: "party" }),
    });
    if (!ticketResponse.ok) throw new Error("게임 접속 티켓을 발급하지 못했습니다.");
    const ticket = await ticketResponse.json() as TicketResponse;
    if (!ticket.token || ticket.token.split(".").length !== 3) throw new Error("유효하지 않은 게임 접속 티켓입니다.");
    const client = new Client(input.serverUrl);
    this.client = client;
    client.auth.token = ticket.token;
    const roomOptions = {
      ...input.options,
      protocolVersion: PROTOCOL_VERSION,
      mapRevision: OFFICIAL_MAP_MANIFEST.mapRevision,
    };
    const room = input.roomId
      ? await client.joinById(input.roomId, roomOptions)
      : await client.joinOrCreate(PARTY_ROOM, roomOptions);
    if (generation !== this.generation) {
      await room.leave(true);
      throw new Error("새 연결 요청으로 대체되었습니다.");
    }
    this.attachRoom(room, generation);
    this.flushRoomReady();
    this.startInputCapture();
    if (room.state) this.handleState(room.state as PartyStateLike);
    return this.latestState;
  }

  subscribe(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    if (this.latestState) listener(this.latestState);
    return () => this.stateListeners.delete(listener);
  }

  subscribeEvents(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  get snapshot(): NetworkWorldSnapshot | null {
    return this.latestState;
  }

  get transportMode(): TransportMode {
    return this.transportModeValue;
  }

  get activeRoomId(): string | null {
    return this.room?.roomId ?? null;
  }

  get unacknowledgedInputs(): InputFrame[] {
    return [...this.pendingInputs.values()];
  }

  /** The room may be joined before Phaser has decoded and warmed its assets. */
  markRendererReady(): void {
    this.rendererReady = true;
    this.flushRoomReady();
  }

  interact(targetId: string): void {
    this.send("player.interact", { targetId });
  }

  requestTravel(waypointId: string, destinationId: string): void {
    this.send("travel.request", { waypointId, destinationId });
  }

  requestRecall(): void {
    this.send("recall.request", {});
  }

  equip(dropId: string): void {
    this.send("equipment.equip", { dropId });
  }

  chooseUpgrade(draftId: string, upgradeId: UpgradeId): void {
    this.send("upgrade.choose", { draftId, upgradeId });
  }

  disconnect(): void {
    this.generation += 1;
    this.reconnecting = false;
    if (this.inputTimer) clearInterval(this.inputTimer);
    this.inputTimer = null;
    this.cleanupInput?.();
    this.cleanupInput = null;
    this.pressed.clear();
    this.closeFastLane();
    this.pendingInputs.clear();
    const room = this.room;
    this.room = null;
    this.client = null;
    void room?.leave(true);
    room?.removeAllListeners();
    this.latestState = null;
    this.minimaps.clear();
    this.clientExploration.clear();
    this.lastExplorationPublishAt = 0;
    this.rendererReady = false;
    this.readySent = false;
  }

  private attachRoom(room: Room, generation: number): void {
    this.room = room;
    this.readySent = false;
    const isCurrentRoom = () => generation === this.generation && this.room === room;
    room.onStateChange((state) => {
      if (isCurrentRoom()) this.handleState(state as PartyStateLike);
    });
    room.onMessage("message", (message: { message?: string }) => {
      if (!isCurrentRoom()) return;
      this.emitEvent({ type: "message", message: message.message });
    });
    room.onMessage("protocol-error", (message: { code?: string }) => {
      if (!isCurrentRoom()) return;
      this.emitEvent({ type: "protocol-error", code: message.code });
    });
    room.onMessage("result", (message: { state?: string; reason?: string; elapsed?: number; day?: number; level?: number; teamPower?: number; stats?: Partial<TeamStats> }) => {
      if (!isCurrentRoom()) return;
      this.terminal = true;
      this.emitEvent({
        type: "result",
        state: message.state,
        message: message.reason,
        elapsed: message.elapsed,
        day: message.day,
        level: message.level,
        teamPower: message.teamPower,
        stats: message.stats,
      });
    });
    room.onMessage("world.frame", (message: unknown) => {
      if (!isCurrentRoom()) return;
      this.handleWorldFrame(message);
    });
    room.onMessage("combat.attack", (message: unknown) => {
      if (!isCurrentRoom()) return;
      const parsed = combatAttackEventSchema.safeParse(message);
      if (parsed.success) gameBridge.emit("combatAttack", parsed.data);
    });
    room.onMessage("minimap.init", (message: unknown) => {
      if (!isCurrentRoom()) return;
      const parsed = minimapInitSchema.safeParse(message);
      if (!parsed.success) return;
      const { geometry, explorationMask, revision } = parsed.data;
      try {
        const mask = decodeMask(explorationMask, Math.ceil(geometry.columns * geometry.rows / 8));
        const current = this.minimaps.get(geometry.areaId);
        if (current?.geometry.mapRevision === geometry.mapRevision && current.revision > revision) return;
        if (current?.geometry.mapRevision === geometry.mapRevision) {
          for (let index = 0; index < mask.length; index += 1) mask[index] |= current.explorationMask[index] ?? 0;
        }
        this.minimaps.set(geometry.areaId, { geometry, explorationMask: mask, revision });
        if (this.latestState) this.revealClientParty(this.latestState.players.map((player) => ({
          id: player.userId,
          roomId: player.roomId,
          x: player.x,
          y: player.y,
          connected: player.connected,
          alive: player.alive,
        })));
        this.publishMinimap();
      } catch {
        // Invalid masks never reach the renderer.
      }
    });
    room.onMessage("minimap.delta", (message: unknown) => {
      if (!isCurrentRoom()) return;
      const parsed = minimapDeltaSchema.safeParse(message);
      if (!parsed.success) return;
      const delta = parsed.data;
      const current = this.minimaps.get(delta.areaId);
      if (!current || current.geometry.mapRevision !== delta.mapRevision) return;
      if (delta.revision <= current.revision) return;
      if (delta.revision !== current.revision + 1) {
        room.send("minimap.resync", { v: PROTOCOL_VERSION, areaId: delta.areaId, mapRevision: delta.mapRevision });
        return;
      }
      const mask = current.explorationMask.slice();
      if (!applyCellRanges(mask, delta.ranges, current.geometry.columns * current.geometry.rows)) return;
      this.minimaps.set(delta.areaId, { ...current, explorationMask: mask, revision: delta.revision });
      this.publishMinimap();
    });
    room.onMessage("fastlane.offer", (message: unknown) => {
      if (!isCurrentRoom()) return;
      const offer = fastLaneOfferSchema.safeParse(message);
      if (offer.success) void this.connectFastLane(offer.data, generation);
    });
    room.onError((code, message) => {
      if (!isCurrentRoom()) return;
      this.emitEvent({ type: "protocol-error", code: String(code), message });
    });
    room.onLeave((code) => {
      if (generation !== this.generation) return;
      if (this.room === room) this.room = null;
      this.closeFastLane();
      this.pendingInputs.clear();
      if (code === 4009 || this.terminal || this.latestState?.phase === "ended") {
        this.emitEvent({ type: "disconnected", code: String(code) });
        return;
      }
      void this.tryReconnect(room.reconnectionToken, generation);
    });
    room.send("fastlane.request", { v: PROTOCOL_VERSION });
    room.send("minimap.ready", { v: PROTOCOL_VERSION });
    this.flushRoomReady();
    setTimeout(() => {
      if (isCurrentRoom() && this.transportModeValue === "websocket-fallback") {
        room.send("fastlane.request", { v: PROTOCOL_VERSION });
      }
    }, 1_000);
  }

  private async tryReconnect(reconnectionToken: string, generation: number): Promise<void> {
    if (this.reconnecting || !this.client) return;
    this.reconnecting = true;
    this.emitEvent({ type: "reconnecting" });
    const reconnectDeadline = performance.now() + 55_000;
    const retryDelays = [0, 250, 500, 1_000, 2_000, 3_500, 5_000, 7_500, 10_000, 12_000, 13_000];
    for (const delay of retryDelays) {
      if (generation !== this.generation || !this.client) return;
      const remainingBeforeDelay = reconnectDeadline - performance.now();
      if (remainingBeforeDelay <= 0) break;
      if (delay > 0) await wait(Math.min(delay, remainingBeforeDelay));
      if (generation !== this.generation || !this.client) return;
      const remaining = reconnectDeadline - performance.now();
      if (remaining <= 0) break;
      try {
        const reconnectPromise = this.client.reconnect(reconnectionToken);
        const room = await withDeadline(reconnectPromise, remaining, async (lateRoom) => {
          lateRoom.removeAllListeners();
          await lateRoom.leave(true);
        });
        if (generation !== this.generation) {
          await room.leave(true);
          return;
        }
        this.reconnecting = false;
        this.attachRoom(room, generation);
        if (room.state) this.handleState(room.state as PartyStateLike);
        this.emitEvent({ type: "reconnected" });
        return;
      } catch (error) {
        if (error instanceof Error && error.message === "RECONNECT_TIMEOUT") break;
        // Retry within the server's 60-second reconnection reservation.
      }
    }
    if (generation !== this.generation) return;
    this.reconnecting = false;
    this.emitEvent({ type: "disconnected" });
  }

  private send(type: string, payload: unknown): void {
    if (!this.room) return;
    this.room.send(type, {
      v: PROTOCOL_VERSION,
      type,
      seq: this.reliableSeq++,
      clientTime: performance.now(),
      payload,
    });
  }

  private flushRoomReady(): void {
    if (!this.room || !this.rendererReady || this.readySent) return;
    this.readySent = true;
    this.send("room.ready", { ready: true });
  }

  private startInputCapture(): void {
    const onKeyDown = (event: KeyboardEvent) => {
      this.pressed.add(event.code);
      if (event.code === "KeyB" && !event.repeat) this.requestRecall();
    };
    const onKeyUp = (event: KeyboardEvent) => this.pressed.delete(event.code);
    const clearPressed = () => this.pressed.clear();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", clearPressed);
    this.inputTimer = setInterval(() => {
      const x = Number(this.pressed.has("KeyD")) - Number(this.pressed.has("KeyA"));
      const y = Number(this.pressed.has("KeyS")) - Number(this.pressed.has("KeyW"));
      const buttons =
        Number(this.pressed.has("Space"));
      this.sendInputFrame({ x, y, aim: this.aim, buttons });
    }, 1000 / 60);

    this.cleanupInput = () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clearPressed);
    };
  }

  /** Phaser owns the camera transform, so it supplies the authoritative local aim. */
  setAim(angle: number): void {
    if (Number.isFinite(angle)) this.aim = normalizeAimAngle(angle);
  }

  private sendInputFrame(payload: Pick<InputFrame, "x" | "y" | "aim" | "buttons">): void {
    if (!this.room) return;
    const frame: InputFrame = {
      v: PROTOCOL_VERSION,
      seq: this.inputSeq++,
      clientTime: performance.now(),
      ...payload,
    };
    this.pendingInputs.set(frame.seq, frame);
    if (this.pendingInputs.size > 240) {
      const oldest = this.pendingInputs.keys().next().value as number | undefined;
      if (oldest !== undefined) this.pendingInputs.delete(oldest);
    }
    gameBridge.emit("localInput", frame);
    const bytes = this.encoder.encode(JSON.stringify({ type: "input.frame", payload: frame }));
    if (this.transportModeValue === "webtransport" && this.fastLaneWriter && (this.fastLaneWriter.desiredSize ?? 1) > 0) {
      void this.fastLaneWriter.write(bytes).catch(() => this.closeFastLane());
    } else {
      this.room.send("input.frame", frame);
    }
  }

  private handleWorldFrame(raw: unknown): void {
    const parsed = worldFrameSchema.safeParse(raw);
    if (!parsed.success) return;
    const frame = parsed.data;
    const revealed = this.revealClientParty(frame.players.map((player) => ({
      id: player.id,
      roomId: player.roomId,
      x: player.x,
      y: player.y,
    })));
    if (revealed > 0 && performance.now() - this.lastExplorationPublishAt >= 120) {
      this.lastExplorationPublishAt = performance.now();
      this.publishMinimap();
    }
    for (const sequence of this.pendingInputs.keys()) {
      if (sequence <= frame.ackInputSeq) this.pendingInputs.delete(sequence);
    }
    gameBridge.emit("worldFrame", frame);
  }

  private async connectFastLane(offer: FastLaneOffer, generation: number): Promise<void> {
    if (typeof WebTransport === "undefined" || offer.expiresAt <= Date.now()) return;
    this.closeFastLane();
    const endpoint = new URL(offer.url);
    endpoint.searchParams.set("token", offer.token);
    const transport = new WebTransport(endpoint.toString(), { congestionControl: "low-latency" });
    this.fastLane = transport;
    try {
      await withDeadline(transport.ready, 2_000, async () => transport.close({ closeCode: 0, reason: "late fast lane" }));
      if (generation !== this.generation || this.fastLane !== transport) {
        transport.close({ closeCode: 0, reason: "stale game connection" });
        return;
      }
      this.fastLaneWriter = transport.datagrams.writable.getWriter();
      this.transportModeValue = "webtransport";
      const reader = transport.datagrams.readable.getReader();
      void this.readFastLane(reader, transport, generation);
      void transport.closed.finally(() => {
        if (this.fastLane === transport) this.closeFastLane();
      }).catch(() => undefined);
    } catch {
      if (this.fastLane === transport) this.closeFastLane();
    }
  }

  private async readFastLane(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    transport: WebTransport,
    generation: number,
  ): Promise<void> {
    try {
      while (generation === this.generation && this.fastLane === transport) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength > 32_768) continue;
        const message = JSON.parse(this.decoder.decode(value)) as { type?: unknown; payload?: unknown };
        if (message.type === "world.frame") this.handleWorldFrame(message.payload);
      }
    } catch {
      // The reliable Colyseus connection remains active and becomes the fallback.
    } finally {
      if (this.fastLane === transport) this.closeFastLane();
    }
  }

  private closeFastLane(): void {
    const transport = this.fastLane;
    this.fastLane = null;
    this.fastLaneWriter = null;
    this.transportModeValue = "websocket-fallback";
    try {
      transport?.close({ closeCode: 0, reason: "fallback to websocket" });
    } catch {
      // Already closed.
    }
  }

  private handleState(state: PartyStateLike): void {
    const players = collectionValues(state.players).map((player): PartyMemberSnapshot => ({
      userId: player.userId ?? "",
      displayName: player.displayName ?? "용사",
      heroClass: isHeroClass(player.heroClass) ? player.heroClass : "swordsman",
      hp: player.hp ?? 0,
      maxHp: player.maxHp ?? 0,
      level: player.level ?? 1,
      teamPower: player.teamPower ?? 0,
      ready: player.ready ?? false,
      connected: player.connected ?? true,
      alive: player.alive ?? (player.hp ?? 0) > 0,
      roomId: player.roomId ?? "zone-1:0,4",
      x: player.x ?? 0,
      y: player.y ?? 0,
      aim: player.aim ?? 0,
      attackSequence: player.attackSequence ?? 0,
      attackTargetId: player.attackTargetId ?? "",
      attackCritical: player.attackCritical ?? false,
      isLocal: player.userId === this.localUserId,
      equipment: equipmentSummaries(player.equipment),
      qCooldown: player.qCooldown ?? 0,
      eCooldown: player.eCooldown ?? 0,
      skillSequence: player.skillSequence ?? 0,
      lastSkillId: player.lastSkillId === "q" || player.lastSkillId === "e" || player.lastSkillId === "dash" ? player.lastSkillId : "",
      skillTargetX: player.skillTargetX ?? 0,
      skillTargetY: player.skillTargetY ?? 0,
      skillRadius: player.skillRadius ?? 0,
      combatStats: {
        attackDamage: player.attackDamage ?? 0,
        defense: player.defense ?? 0,
        criticalChance: player.criticalChance ?? 0,
        criticalDamage: player.criticalDamage ?? 150,
        attacksPerSecond: player.attacksPerSecond ?? 0,
        attackRange: player.attackRange ?? 0,
        moveSpeed: player.moveSpeed ?? 0,
      },
    }));
    const localRoomId = players.find((player) => player.isLocal)?.roomId ?? "";
    this.revealClientParty(players.map((player) => ({
      id: player.userId,
      roomId: player.roomId,
      x: player.x,
      y: player.y,
      connected: player.connected,
      alive: player.alive,
    })));
    const localPlayerState = collectionValues(state.players).find((player) => player.userId === this.localUserId);
    const draft = localPlayerState?.upgradeDraft;
    const localUpgradeDraft = draft?.active && draft.draftId
      ? {
        draftId: draft.draftId,
        level: draft.level ?? 1,
        choices: collectionValues(draft.choices)
          .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
          .map((choice): UpgradeChoice => ({
            id: (choice.upgradeId ?? "power") as UpgradeId,
            name: choice.name ?? "공격 증강",
            description: choice.description ?? "공격 능력을 강화합니다.",
            tag: upgradeTag(choice.upgradeId),
            maxStacks: choice.maxStacks ?? 1,
            rarity: isUpgradeRarity(choice.rarity) ? choice.rarity : "normal",
            stack: choice.stack ?? 0,
          })),
      }
      : null;
    const stats = collectionValues(state.players).reduce<TeamStats>((total, player) => ({
      damage: total.damage + (player.damage ?? 0),
      bossDamage: total.bossDamage + (player.bossDamage ?? 0),
      kills: total.kills + (player.kills ?? 0),
      deaths: total.deaths + (player.deaths ?? 0),
      structuresBuilt: total.structuresBuilt + (player.structuresBuilt ?? 0),
      goldSpent: total.goldSpent + (player.goldSpent ?? 0),
      gatesDestroyed: total.gatesDestroyed + (player.gatesDestroyed ?? 0),
    }), {
      damage: 0,
      bossDamage: 0,
      kills: 0,
      deaths: 0,
      structuresBuilt: 0,
      goldSpent: 0,
      gatesDestroyed: 0,
    });
    const connections = new Map<string, string[]>();
    for (const door of collectionValues(state.doors)) {
      if (!door.fromRoomId || !door.toRoomId) continue;
      connections.set(door.fromRoomId, [...(connections.get(door.fromRoomId) ?? []), door.toRoomId]);
      connections.set(door.toRoomId, [...(connections.get(door.toRoomId) ?? []), door.fromRoomId]);
    }
    const rooms = collectionValues(state.rooms).map((room): RoomMapCell => ({
      id: room.id ?? "",
      zone: room.zone ?? 1,
      x: room.gridX ?? room.x ?? 0,
      y: room.gridY ?? room.y ?? 0,
      type: isRoomType(room.kind) ? room.kind : isRoomType(room.roomType) ? room.roomType : "empty",
      visited: room.discovered ?? room.visited ?? false,
      current: room.id === localRoomId,
      cleared: room.cleared ?? false,
      connections: collectionValues(room.connections).length > 0 ? collectionValues(room.connections) : connections.get(room.id ?? "") ?? [],
    }));
    const enemies = collectionValues(state.enemies).map((enemy): NetworkEnemySnapshot => ({
      id: enemy.id ?? "",
      kind: enemy.kind ?? "grunt",
      behavior: isEnemyBehavior(enemy.behavior) ? enemy.behavior : "static",
      roomId: enemy.roomId ?? "",
      spawnRoomId: enemy.spawnRoomId ?? enemy.roomId ?? "",
      targetId: enemy.targetId ?? "",
      x: enemy.x ?? 0,
      y: enemy.y ?? 0,
      hp: enemy.hp ?? 0,
      maxHp: enemy.maxHp ?? 0,
      alive: enemy.alive ?? true,
      patternKind: enemy.patternKind === "floor" ? "floor" : "fan",
      patternPhase: enemy.patternPhase === "telegraph" ? "telegraph" : "idle",
      patternRemaining: enemy.patternRemaining ?? 0,
      patternIndex: enemy.patternIndex ?? 0,
      attackSequence: enemy.attackSequence ?? 0,
    }));
    const drops = collectionValues(state.drops)
      .filter((drop) => drop.ownerUserId === this.localUserId && !drop.claimed && isDropSlot(drop.slot) && isDropRarity(drop.rarity))
      .map((drop): NetworkDropSnapshot => ({
        id: drop.id ?? "",
        ownerUserId: drop.ownerUserId ?? "",
        roomId: drop.roomId ?? "",
        slot: drop.slot as NetworkDropSnapshot["slot"],
        rarity: drop.rarity as NetworkDropSnapshot["rarity"],
        x: drop.x ?? 0,
        y: drop.y ?? 0,
        specialOptionCount: drop.specialOptionCount ?? 0,
      }));
    const waypoints = collectionValues(state.waypoints).map((waypoint) => ({
      id: waypoint.id ?? "",
      roomId: waypoint.roomId ?? "",
      kind: isWaypointKind(waypoint.kind) ? waypoint.kind : "central" as const,
      destinationId: waypoint.destinationId ?? "",
      active: waypoint.active ?? false,
      requiredPlayers: waypoint.requiredPlayers ?? 0,
      holdingPlayers: waypoint.holdingPlayers ?? 0,
      holdProgress: waypoint.holdProgress ?? 0,
      holdDurationMs: waypoint.holdDurationMs ?? 5_000,
    }));
    const snapshot: NetworkWorldSnapshot = {
      matchId: state.matchId ?? "",
      seed: state.seed ?? "",
      phase: isNetworkPhase(state.phase) ? state.phase : "lobby",
      resultState: isNetworkResult(state.resultState) ? state.resultState : null,
      resultReason: state.resultReason ?? "",
      day: state.day ?? 1,
      serverTime: state.serverTime ?? Date.now(),
      elapsed: state.elapsed ?? 0,
      phaseEndsAt: state.phaseEndsAt ?? 0,
      baseHp: state.baseHp ?? 0,
      baseMaxHp: state.baseMaxHp ?? 900,
      gold: state.gold ?? 0,
      currentZone: state.currentZone ?? 1,
      teamLevel: state.teamLevel ?? 1,
      teamXp: state.teamXp ?? 0,
      teamXpToNext: state.teamXpToNext ?? 20,
      players,
      rooms,
      enemies,
      drops,
      waypoints,
      waypointHoldProgress: state.waypointHoldProgress ?? Math.max(0, ...waypoints.map((waypoint) => waypoint.holdProgress)),
      localUpgradeDraft,
      stats,
      minimap: this.minimapForRoom(localRoomId),
    };
    this.latestState = snapshot;
    gameBridge.emit("network", snapshot);
    this.stateListeners.forEach((listener) => listener(snapshot));
  }

  private minimapForRoom(roomId: string): MiniMapSnapshot | null {
    const areaId = minimapAreaIdForRoom(roomId);
    return areaId ? this.minimaps.get(areaId) ?? null : null;
  }

  private revealClientParty(actors: readonly ExplorationActor[]): number {
    let revealed = 0;
    for (const [areaId, minimap] of this.minimaps) {
      const areaActors = actors.filter((actor) => minimapAreaIdForRoom(actor.roomId) === areaId);
      if (areaActors.length === 0) continue;
      const areaRevealed = this.clientExploration.reveal(minimap, areaActors);
      if (areaRevealed === 0) continue;
      revealed += areaRevealed;
      // Replace the wrapper so React/canvas consumers observe the mutated mask.
      // revision remains the server protocol revision for backwards-compatible deltas.
      this.minimaps.set(areaId, { ...minimap });
    }
    return revealed;
  }

  private publishMinimap(): void {
    if (!this.latestState) return;
    const localRoomId = this.latestState.players.find((player) => player.isLocal)?.roomId ?? "";
    const snapshot = { ...this.latestState, minimap: this.minimapForRoom(localRoomId) };
    this.latestState = snapshot;
    gameBridge.emit("network", snapshot);
    this.stateListeners.forEach((listener) => listener(snapshot));
  }

  private emitEvent(event: TransportEvent): void {
    this.eventListeners.forEach((listener) => listener(event));
  }
}

export function minimapAreaIdForRoom(roomId: string): string | null {
  if (roomId.startsWith("editor:")) return "official-map";
  if (roomId === "boss:arena") return "zone-3";
  return /^zone-(\d+)/u.exec(roomId)?.[0] ?? null;
}

function collectionValues<T>(collection: SchemaCollection<T> | T[] | undefined): T[] {
  if (!collection) return [];
  if (Array.isArray(collection)) return [...collection];
  const values: T[] = [];
  collection.forEach((value) => values.push(value));
  return values;
}

function isHeroClass(value: string | undefined): value is HeroClassId {
  return value === "swordsman" || value === "archer" || value === "mage";
}

function isNetworkPhase(value: string | undefined): value is NetworkWorldSnapshot["phase"] {
  return value === "lobby" || value === "day" || value === "night" || value === "standby" || value === "boss" || value === "ended";
}

function isNetworkResult(value: string | undefined): value is Exclude<NetworkWorldSnapshot["resultState"], null> {
  return value === "victory" || value === "defeat" || value === "abandoned";
}

function isRoomType(value: string | undefined): value is RoomMapCell["type"] {
  return value === "start" || value === "gate" || value === "resource" || value === "static-monster" || value === "empty" || value === "central-waypoint" || value === "hidden-monster" || value === "boss";
}

function isEnemyBehavior(value: string | undefined): value is NetworkEnemySnapshot["behavior"] {
  return value === "static" || value === "invader" || value === "hidden" || value === "gate" || value === "boss";
}

function isWaypointKind(value: string | undefined): value is NetworkWorldSnapshot["waypoints"][number]["kind"] {
  return value === "start" || value === "central" || value === "gate" || value === "boss";
}

function isDropSlot(value: string | undefined): value is NetworkDropSnapshot["slot"] {
  return value === "weapon" || value === "armor" || value === "accessory";
}

function isDropRarity(value: string | undefined): value is NetworkDropSnapshot["rarity"] {
  return value === "legendary" || value === "mythic";
}

async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onLateResolve: (value: T) => Promise<void>,
): Promise<T> {
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      reject(new Error("RECONNECT_TIMEOUT"));
    }, Math.max(1, timeoutMs));
  });
  operation.then((value) => {
    if (timedOut) void onLateResolve(value).catch(() => undefined);
  }).catch(() => undefined);
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isUpgradeRarity(value: string | undefined): value is UpgradeChoice["rarity"] {
  return value === "normal" || value === "rare" || value === "epic";
}

function upgradeTag(upgradeId: string | undefined): UpgradeChoice["tag"] {
  if (upgradeId?.startsWith("swordsman-")) return "검사";
  if (upgradeId?.startsWith("archer-")) return "궁수";
  if (upgradeId?.startsWith("mage-")) return "마법사";
  return "공용";
}

function equipmentSummaries(equipment: PlayerStateLike["equipment"]): EquipmentSummary[] {
  if (!equipment) return [];
  const result: EquipmentSummary[] = [];
  const append = (
    slot: EquipmentSummary["slot"],
    id: string | undefined,
    rarityValue: string | undefined,
    power: number,
  ) => {
    const rarity = isEquipmentRarity(rarityValue) ? rarityValue : null;
    if (!id || !rarity) return;
    const slotName = slot === "weapon" ? "무기" : slot === "armor" ? "방어구" : "장신구";
    result.push({ slot, rarity, power, name: `${rarityName(rarity)} ${slotName}` });
  };
  append("weapon", equipment.weaponId, equipment.weaponRarity, equipment.attackBonus ?? 0);
  append("armor", equipment.armorId, equipment.armorRarity, (equipment.maxHpBonus ?? 0) + (equipment.defenseBonus ?? 0));
  append("accessory", equipment.accessoryId, equipment.accessoryRarity, equipment.attackSpeedBonus ?? 0);
  return result;
}

function isEquipmentRarity(value: string | undefined): value is EquipmentSummary["rarity"] {
  return value === "normal" || value === "rare" || value === "epic" || value === "legendary" || value === "mythic";
}

function rarityName(rarity: EquipmentSummary["rarity"]): string {
  if (rarity === "mythic") return "신화";
  if (rarity === "legendary") return "레전더리";
  if (rarity === "epic") return "에픽";
  if (rarity === "rare") return "레어";
  return "노말";
}

export const colyseusTransport = new ColyseusTransport();

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
