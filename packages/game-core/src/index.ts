import type { HeroClassId, PlayerInputCommand } from "@five-days/protocol";

export type CorePhase = "lobby" | "day" | "night" | "standby" | "boss" | "ended";
export type CoreResult = "victory" | "defeat" | "abandoned";

export type CorePlayer = {
  userId: string;
  displayName: string;
  heroClass: HeroClassId;
  x: number;
  y: number;
  aim: number;
  hp: number;
  maxHp: number;
  level: number;
  teamPower: number;
  ready: boolean;
  connected: boolean;
  lastSeq: number;
  inputX: number;
  inputY: number;
  damage: number;
  bossDamage: number;
  kills: number;
  deaths: number;
  structuresBuilt: number;
  goldSpent: number;
  gatesDestroyed: number;
};

export type GameCoreOptions = {
  mode: "prototype" | "full";
  difficulty: "easy" | "normal" | "hard";
  seed: string;
  minimumPlayers?: number;
};

const durations = {
  prototype: { day: 60, night: 25, standby: 5 },
  full: { day: 210, night: 75, standby: 15 },
} as const;

const classStats = {
  swordsman: { hp: 150, speed: 230, power: 115 },
  archer: { hp: 105, speed: 255, power: 120 },
  mage: { hp: 95, speed: 240, power: 125 },
} as const;

export class GameCore {
  readonly players = new Map<string, CorePlayer>();
  phase: CorePhase = "lobby";
  day = 1;
  elapsed = 0;
  phaseRemaining = 0;
  baseHp = 900;
  gold = 100;
  result: CoreResult | null = null;
  resultReason = "";
  private readonly minimumPlayers: number;

  constructor(readonly options: GameCoreOptions) {
    this.minimumPlayers = options.minimumPlayers ?? 3;
  }

  addPlayer(input: { userId: string; displayName: string; heroClass: HeroClassId }): CorePlayer {
    const existing = this.players.get(input.userId);
    if (existing) {
      existing.connected = true;
      return existing;
    }
    const stats = classStats[input.heroClass];
    const player: CorePlayer = {
      ...input,
      x: 320 + this.players.size * 72,
      y: 1250,
      aim: 0,
      hp: stats.hp,
      maxHp: stats.hp,
      level: 1,
      teamPower: stats.power,
      ready: false,
      connected: true,
      lastSeq: -1,
      inputX: 0,
      inputY: 0,
      damage: 0,
      bossDamage: 0,
      kills: 0,
      deaths: 0,
      structuresBuilt: 0,
      goldSpent: 0,
      gatesDestroyed: 0,
    };
    this.players.set(input.userId, player);
    return player;
  }

  setConnected(userId: string, connected: boolean): void {
    const player = this.players.get(userId);
    if (player) {
      player.connected = connected;
      if (!connected) {
        player.inputX = 0;
        player.inputY = 0;
      }
    }
  }

  setReady(userId: string, ready: boolean): boolean {
    if (this.phase !== "lobby") return false;
    const player = this.players.get(userId);
    if (!player) return false;
    player.ready = ready;
    if (this.players.size >= this.minimumPlayers && [...this.players.values()].every((value) => value.ready)) {
      this.phase = "day";
      this.phaseRemaining = durations[this.options.mode].day;
    }
    return true;
  }

  applyInput(userId: string, command: PlayerInputCommand): boolean {
    if (this.phase === "lobby" || this.phase === "ended") return false;
    const player = this.players.get(userId);
    if (!player || command.seq <= player.lastSeq) return false;
    player.lastSeq = command.seq;
    const magnitude = Math.hypot(command.payload.x, command.payload.y);
    const scale = magnitude > 1 ? 1 / magnitude : 1;
    player.inputX = command.payload.x * scale;
    player.inputY = command.payload.y * scale;
    player.aim = command.payload.aim;
    return true;
  }

  update(deltaSeconds: number): void {
    if (this.phase === "lobby" || this.phase === "ended") return;
    const delta = Math.max(0, Math.min(0.1, deltaSeconds));
    this.elapsed += delta;
    for (const player of this.players.values()) {
      const stats = classStats[player.heroClass];
      player.x = clamp(player.x + player.inputX * stats.speed * delta, 0, 2560);
      player.y = clamp(player.y + player.inputY * stats.speed * delta, 0, 1600);
    }
    if (this.phase === "boss") return;
    this.phaseRemaining -= delta;
    if (this.phaseRemaining > 0) return;

    if (this.phase === "day") this.transition("night");
    else if (this.phase === "night") this.transition("standby");
    else {
      this.day += 1;
      if (this.day > 5) this.finish("defeat", "마왕을 제한 시간 안에 쓰러뜨리지 못했습니다.");
      else this.transition("day");
    }
  }

  startBoss(): boolean {
    if (this.phase === "ended" || this.day < 3) return false;
    this.phase = "boss";
    this.phaseRemaining = 0;
    return true;
  }

  finish(result: CoreResult, reason: string): void {
    if (this.phase === "ended") return;
    this.phase = "ended";
    this.phaseRemaining = 0;
    this.result = result;
    this.resultReason = reason;
  }

  private transition(phase: "day" | "night" | "standby"): void {
    this.phase = phase;
    this.phaseRemaining = durations[this.options.mode][phase];
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
