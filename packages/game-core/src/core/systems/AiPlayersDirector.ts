import { CLASS_COMBAT_RULES, selectNearestConeEnemy, type CoreEnemy, type CoreRoomId } from "../../v02/simulation";
import type { GameCore } from "../GameCore";
import {
  ACTOR_COLLISION_RADIUS,
  AI_FOLLOWER_GAP,
  AI_PATH_REPLAN_SECONDS,
  AI_PATH_TARGET_DRIFT,
  AI_PATH_WAYPOINT_RADIUS,
} from "../constants";
import type { AiFollowNavigation, CorePlayer } from "../types";
import { findWalkableDiscPath, isWalkableDiscLine, isWalkableDiscLineIndexed } from "../../v02/world";
import { createSeededRandom, type RandomSource } from "../../v02/random";

const DEFENDER_PATROL_EDGE_MARGIN = 48;
const DEFENDER_PATROL_ARRIVAL_RADIUS = 24;
const DEFENDER_PATROL_MIN_DISTANCE = 96;
const DEFENDER_PATROL_MIN_WAIT_SECONDS = 0.6;
const DEFENDER_PATROL_MAX_WAIT_SECONDS = 1.4;

type DefenderPatrolState = {
  random: RandomSource;
  targetX: number;
  targetY: number;
  waitUntil: number;
};

/**
 * Drives `ai:` party members. The first AI guards the base (defender); the
 * rest follow the nearest human leader (follower) and engage enemies in their
 * room. Drives input + aim so the shared movement/attack pipeline moves them.
 */
export class AiPlayersDirector {
  private readonly aiFollowNavigation = new Map<string, AiFollowNavigation>();
  private readonly respawnRecovery = new Map<string, { path: readonly Readonly<{ x: number; y: number }>[]; waypointIndex: number }>();
  private readonly partyNavigation = new Map<string, {
    from: CoreRoomId;
    to: CoreRoomId;
    points: readonly Readonly<{ x: number; y: number }>[];
    waypointIndex: number;
  }>();
  private readonly defenderPatrols = new Map<string, DefenderPatrolState>();

  constructor(private readonly core: GameCore) {}

  onRespawn(player: CorePlayer): void {
    this.aiFollowNavigation.delete(player.userId);
    this.partyNavigation.delete(player.userId);
    this.respawnRecovery.delete(player.userId);
    this.defenderPatrols.delete(player.userId);
    if (player.aiRole !== "follower") return;
    const leader = this.aiLeader(player);
    if (!leader) return;
    // Authored worlds already have room/corridor graph navigation. Let the
    // regular update loop traverse that graph one connection at a time instead
    // of synchronously solving a multi-zone A* path during the respawn tick.
    if (this.core.authoredWorld) return;
    const rects = this.recoveryWalkable(player, leader);
    if (!rects) return;
    const path = findWalkableDiscPath(
      rects,
      { x: player.x, y: player.y },
      { x: leader.x, y: leader.y },
      ACTOR_COLLISION_RADIUS,
    );
    if (path?.length) this.respawnRecovery.set(player.userId, { path, waypointIndex: 0 });
  }

  update(): void {
    for (const player of this.core.players.values()) {
      if (player.aiRole !== "defender") this.defenderPatrols.delete(player.userId);
      if (!player.aiRole || !player.alive) {
        if (player.aiRole) {
          player.inputX = 0;
          player.inputY = 0;
          this.aiFollowNavigation.delete(player.userId);
          this.defenderPatrols.delete(player.userId);
        }
        continue;
      }
      if (this.core.phase === "lobby" || this.core.phase === "ended") {
        player.inputX = 0;
        player.inputY = 0;
        continue;
      }
      const leader = this.aiLeader(player);
      const respawnAnchor = leader ? this.respawnRecoveryAnchor(player, leader) : null;
      if (respawnAnchor) {
        this.aiApproach(player, respawnAnchor.x, respawnAnchor.y, 12);
        continue;
      }
      const targetRoom = player.aiRole === "defender"
        ? this.core.rooms.get(this.core.startRoomId())
        : leader ? this.core.rooms.get(leader.roomId) : null;
      if (!targetRoom) {
        player.inputX = 0;
        player.inputY = 0;
        continue;
      }
      const recoveryAnchor = player.aiRole === "follower" && leader
        ? this.distantAiFollowAnchor(player, leader)
        : null;
      if (recoveryAnchor) {
        this.aiApproach(player, recoveryAnchor.x, recoveryAnchor.y, 12);
      } else if (player.aiRole === "defender" && player.roomId === targetRoom.id) {
        const invader = this.nearestBaseInvader(player, targetRoom.id);
        if (invader) {
          this.defenderPatrols.delete(player.userId);
          player.aim = Math.atan2(invader.y - player.y, invader.x - player.x);
          const attackRange = this.core.combatStats(player.userId)?.attackRange
            ?? CLASS_COMBAT_RULES[player.heroClass].attackRange;
          this.aiApproach(player, invader.x, invader.y, attackRange * 0.75);
          if (this.core.phase === "day" || this.core.phase === "night" || this.core.phase === "boss") {
            this.core.performAutoAttack(player.userId);
          }
        } else {
          this.updateDefenderPatrol(player);
        }
      } else if (player.roomId === targetRoom.id) {
        const anchor = player.aiRole === "follower" && leader
          ? { x: leader.x, y: leader.y }
          : this.core.roomWorldCenterOf(targetRoom.id);
        this.aiApproach(player, anchor.x, anchor.y, player.aiRole === "follower" ? AI_FOLLOWER_GAP : 40);
      } else {
        if (player.aiRole === "defender") this.defenderPatrols.delete(player.userId);
        const nextRoom = this.nextRoomToward(player.roomId, targetRoom.id);
        const anchor = nextRoom
          ? this.authoredPartyNavigationAnchor(player, nextRoom)
          : this.core.roomWorldCenterOf(targetRoom.id);
        this.aiApproach(player, anchor.x, anchor.y, 12);
      }
      const enemy = player.aiRole === "defender" ? null : this.nearestPlayerInRoomEnemy(player);
      if (enemy && (this.core.phase === "day" || this.core.phase === "night" || this.core.phase === "boss")) {
        player.aim = Math.atan2(enemy.y - player.y, enemy.x - player.x);
        this.core.performAutoAttack(player.userId);
      }
    }
  }

  private nearestBaseInvader(player: CorePlayer, baseRoomId: CoreRoomId): CoreEnemy | null {
    let nearest: CoreEnemy | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const enemy of this.core.enemies.values()) {
      if (!enemy.alive || enemy.behavior !== "invader" || enemy.roomId !== baseRoomId) continue;
      const distance = Math.hypot(enemy.x - player.x, enemy.y - player.y);
      if (distance < nearestDistance) {
        nearest = enemy;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  private updateDefenderPatrol(player: CorePlayer): void {
    let patrol = this.defenderPatrols.get(player.userId);
    if (!patrol) {
      const random = createSeededRandom(`${this.core.options.seed}:defender-patrol:${player.userId}`);
      const target = this.nextDefenderPatrolTarget(player, random);
      patrol = { random, targetX: target.x, targetY: target.y, waitUntil: 0 };
      this.defenderPatrols.set(player.userId, patrol);
    }

    const distance = Math.hypot(patrol.targetX - player.x, patrol.targetY - player.y);
    if (distance > DEFENDER_PATROL_ARRIVAL_RADIUS) {
      patrol.waitUntil = 0;
      this.aiApproach(player, patrol.targetX, patrol.targetY, DEFENDER_PATROL_ARRIVAL_RADIUS);
      return;
    }

    player.inputX = 0;
    player.inputY = 0;
    if (patrol.waitUntil === 0) {
      const waitRange = DEFENDER_PATROL_MAX_WAIT_SECONDS - DEFENDER_PATROL_MIN_WAIT_SECONDS;
      patrol.waitUntil = this.core.elapsed + DEFENDER_PATROL_MIN_WAIT_SECONDS + patrol.random.next() * waitRange;
      return;
    }
    if (this.core.elapsed < patrol.waitUntil) return;

    const target = this.nextDefenderPatrolTarget(player, patrol.random);
    patrol.targetX = target.x;
    patrol.targetY = target.y;
    patrol.waitUntil = 0;
    this.aiApproach(player, patrol.targetX, patrol.targetY, DEFENDER_PATROL_ARRIVAL_RADIUS);
  }

  private nextDefenderPatrolTarget(player: CorePlayer, random: RandomSource): Readonly<{ x: number; y: number }> {
    const rect = this.core.roomRectOf(this.core.startRoomId());
    const inset = ACTOR_COLLISION_RADIUS + DEFENDER_PATROL_EDGE_MARGIN;
    const minimumX = rect.x + inset;
    const maximumX = rect.x + rect.width - inset;
    const minimumY = rect.y + inset;
    const maximumY = rect.y + rect.height - inset;
    if (maximumX <= minimumX || maximumY <= minimumY) return this.core.roomWorldCenterOf(this.core.startRoomId());

    let best = { x: minimumX, y: minimumY };
    let bestDistance = -1;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = {
        x: minimumX + random.next() * (maximumX - minimumX),
        y: minimumY + random.next() * (maximumY - minimumY),
      };
      const distance = Math.hypot(candidate.x - player.x, candidate.y - player.y);
      if (distance >= DEFENDER_PATROL_MIN_DISTANCE) return candidate;
      if (distance > bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best;
  }

  private aiLeader(ai: CorePlayer): CorePlayer | null {
    let best: CorePlayer | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of this.core.players.values()) {
      if (candidate.userId === ai.userId || candidate.aiRole || !candidate.alive) continue;
      const distance = Math.hypot(candidate.x - ai.x, candidate.y - ai.y);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best ?? [...this.core.players.values()].find((candidate) => candidate.userId !== ai.userId && candidate.alive) ?? null;
  }

  private respawnRecoveryAnchor(player: CorePlayer, leader: CorePlayer): Readonly<{ x: number; y: number }> | null {
    const recovery = this.respawnRecovery.get(player.userId);
    if (!recovery) return null;
    if (Math.hypot(leader.x - player.x, leader.y - player.y) <= AI_FOLLOWER_GAP) {
      this.respawnRecovery.delete(player.userId);
      return null;
    }
    while (recovery.waypointIndex < recovery.path.length) {
      const waypoint = recovery.path[recovery.waypointIndex]!;
      if (Math.hypot(waypoint.x - player.x, waypoint.y - player.y) > AI_PATH_WAYPOINT_RADIUS) return waypoint;
      recovery.waypointIndex += 1;
    }
    this.respawnRecovery.delete(player.userId);
    return null;
  }

  private recoveryWalkable(player: CorePlayer, leader: CorePlayer) {
    const playerRoom = this.core.rooms.get(player.roomId);
    const leaderRoom = this.core.rooms.get(leader.roomId);
    return playerRoom?.zone === leaderRoom?.zone
      ? this.core.zoneWorlds.get(playerRoom?.zone ?? 1)?.rects ?? null
      : null;
  }

  private distantAiFollowAnchor(player: CorePlayer, leader: CorePlayer): Readonly<{ x: number; y: number }> | null {
    const distance = Math.hypot(leader.x - player.x, leader.y - player.y);
    const playerRoom = this.core.rooms.get(player.roomId);
    const leaderRoom = this.core.rooms.get(leader.roomId);
    const rects = this.core.authoredWorld
      ? playerRoom ? [this.core.roomRectOf(player.roomId)] : null
      : playerRoom?.zone === leaderRoom?.zone ? this.core.zoneWorlds.get(playerRoom?.zone ?? 1)?.rects : null;
    if (!rects) return null;

    // Between authored rooms, nextRoomToward/authoredPartyNavigationAnchor
    // follows the deterministic room graph without a blocking world-scale A*.
    if (this.core.authoredWorld && player.roomId !== leader.roomId) return null;

    // Straight-line distance is not a valid navigation criterion: two close
    // positions can still be separated by a wall. Only bypass A* when the
    // actor's full collision disc has a direct walkable line to the leader.
    // Otherwise A* accumulates the real route length around corridor bends.
    if (isWalkableDiscLine(rects, player.x, player.y, leader.x, leader.y, ACTOR_COLLISION_RADIUS)) {
      this.aiFollowNavigation.delete(player.userId);
      return player.roomId === leader.roomId ? null : { x: leader.x, y: leader.y };
    }
    if (player.roomId === leader.roomId && distance <= AI_FOLLOWER_GAP) {
      this.aiFollowNavigation.delete(player.userId);
      return null;
    }

    let navigation = this.aiFollowNavigation.get(player.userId);
    const targetDrift = navigation
      ? Math.hypot(leader.x - navigation.targetX, leader.y - navigation.targetY)
      : Number.POSITIVE_INFINITY;
    if (!navigation || this.core.elapsed >= navigation.replanAt || targetDrift >= AI_PATH_TARGET_DRIFT) {
      const path = findWalkableDiscPath(
        rects,
        { x: player.x, y: player.y },
        { x: leader.x, y: leader.y },
        ACTOR_COLLISION_RADIUS,
      );
      if (!path || path.length === 0) {
        this.aiFollowNavigation.delete(player.userId);
        return null;
      }
      navigation = {
        targetX: leader.x,
        targetY: leader.y,
        path,
        waypointIndex: 0,
        replanAt: this.core.elapsed + AI_PATH_REPLAN_SECONDS,
      };
      this.aiFollowNavigation.set(player.userId, navigation);
    }

    while (navigation.waypointIndex < navigation.path.length) {
      const waypoint = navigation.path[navigation.waypointIndex]!;
      if (Math.hypot(waypoint.x - player.x, waypoint.y - player.y) > AI_PATH_WAYPOINT_RADIUS) return waypoint;
      navigation.waypointIndex += 1;
    }
    this.aiFollowNavigation.delete(player.userId);
    return null;
  }

  private aiApproach(player: CorePlayer, x: number, y: number, desiredGap: number): void {
    const dx = x - player.x;
    const dy = y - player.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= desiredGap) {
      player.inputX = 0;
      player.inputY = 0;
      return;
    }
    player.inputX = dx / distance;
    player.inputY = dy / distance;
  }

  private nearestPlayerInRoomEnemy(player: CorePlayer): ReturnType<typeof selectNearestConeEnemy> {
    const rules = CLASS_COMBAT_RULES[player.heroClass];
    return selectNearestConeEnemy(player, this.core.enemies.values(), rules.attackRange, Math.PI);
  }

  private nextRoomToward(from: CoreRoomId, destination: CoreRoomId): CoreRoomId | null {
    if (from === destination) return destination;
    const queue: CoreRoomId[] = [from];
    const previous = new Map<CoreRoomId, CoreRoomId | null>([[from, null]]);
    while (queue.length > 0) {
      const current = queue.shift() as CoreRoomId;
      for (const connection of this.core.rooms.get(current)?.connections ?? []) {
        if (previous.has(connection)) continue;
        previous.set(connection, current);
        if (connection === destination) {
          let cursor: CoreRoomId = destination;
          while (previous.get(cursor) && previous.get(cursor) !== from) cursor = previous.get(cursor) as CoreRoomId;
          return cursor;
        }
        queue.push(connection);
      }
    }
    return null;
  }

  private authoredPartyNavigationAnchor(
    player: CorePlayer,
    nextRoomId: CoreRoomId,
  ): Readonly<{ x: number; y: number }> {
    if (!this.core.authoredWorld) return this.core.roomWorldCenterOf(nextRoomId);
    const connection = this.core.authoredWorld.connections.find((candidate) => (
      candidate.from === player.roomId && candidate.to === nextRoomId
      || candidate.to === player.roomId && candidate.from === nextRoomId
    ));
    if (!connection) return this.core.roomWorldCenterOf(nextRoomId);
    const existing = this.partyNavigation.get(player.userId);
    const navigation = existing && existing.from === player.roomId && existing.to === nextRoomId
      ? existing
      : (() => {
          const authoredPoints = connection.from === player.roomId ? connection.points : [...connection.points].reverse();
          const nextCenter = this.core.roomWorldCenterOf(nextRoomId);
          const currentRect = this.core.roomRectOf(player.roomId);
          const nextRect = this.core.roomRectOf(nextRoomId);
          const points = authoredPoints.length > 0
            ? authoredPoints
            : findWalkableDiscPath(
                [currentRect, ...connection.floorRects, nextRect],
                player,
                nextCenter,
                ACTOR_COLLISION_RADIUS,
              ) ?? [nextCenter];
          return {
            from: player.roomId,
            to: nextRoomId,
            points,
            // The room id remains the source room while an actor is physically
            // inside its corridor. Restarting at point zero would send an actor
            // that already passed the doorway back in the opposite direction.
            waypointIndex: this.furthestReachableConnectionPoint(player.x, player.y, points),
          };
        })();
    const points = navigation.points;
    while (navigation.waypointIndex < points.length) {
      const point = points[navigation.waypointIndex]!;
      if (Math.hypot(point.x - player.x, point.y - player.y) > 24) break;
      navigation.waypointIndex += 1;
    }
    this.partyNavigation.set(player.userId, navigation);
    return points[navigation.waypointIndex] ?? this.core.roomWorldCenterOf(nextRoomId);
  }

  private furthestReachableConnectionPoint(
    x: number,
    y: number,
    points: readonly Readonly<{ x: number; y: number }>[],
  ): number {
    if (!this.core.authoredWorld) return 0;
    let furthest = 0;
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index]!;
      const reachable = this.core.authoredSpatialIndex
        ? isWalkableDiscLineIndexed(this.core.authoredSpatialIndex, x, y, point.x, point.y, ACTOR_COLLISION_RADIUS)
        : isWalkableDiscLine(this.core.authoredWalkable(), x, y, point.x, point.y, ACTOR_COLLISION_RADIUS);
      if (reachable) {
        furthest = index;
      }
    }
    return furthest;
  }
}
