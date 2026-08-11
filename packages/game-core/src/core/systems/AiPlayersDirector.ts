import { CLASS_COMBAT_RULES, selectNearestConeEnemy, type CoreRoomId } from "../../v02/simulation";
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

/**
 * Drives `ai:` party members. The first AI guards the base (defender); the
 * rest follow the nearest human leader (follower) and engage enemies in their
 * room. Drives input + aim so the shared movement/attack pipeline moves them.
 */
export class AiPlayersDirector {
  private readonly aiFollowNavigation = new Map<string, AiFollowNavigation>();
  private readonly partyNavigation = new Map<string, { from: CoreRoomId; to: CoreRoomId; waypointIndex: number }>();

  constructor(private readonly core: GameCore) {}

  update(): void {
    for (const player of this.core.players.values()) {
      if (!player.aiRole || !player.alive) {
        if (player.aiRole) {
          player.inputX = 0;
          player.inputY = 0;
          this.aiFollowNavigation.delete(player.userId);
        }
        continue;
      }
      if (this.core.phase === "lobby" || this.core.phase === "ended") {
        player.inputX = 0;
        player.inputY = 0;
        continue;
      }
      const leader = this.aiLeader(player);
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
      } else if (player.roomId === targetRoom.id) {
        const anchor = player.aiRole === "follower" && leader
          ? { x: leader.x, y: leader.y }
          : this.core.roomWorldCenterOf(targetRoom.id);
        this.aiApproach(player, anchor.x, anchor.y, player.aiRole === "follower" ? AI_FOLLOWER_GAP : 40);
      } else {
        const nextRoom = this.nextRoomToward(player.roomId, targetRoom.id);
        const anchor = nextRoom
          ? this.authoredPartyNavigationAnchor(player, nextRoom)
          : this.core.roomWorldCenterOf(targetRoom.id);
        this.aiApproach(player, anchor.x, anchor.y, 12);
      }
      const enemy = this.nearestPlayerInRoomEnemy(player);
      if (enemy && (this.core.phase === "day" || this.core.phase === "night" || this.core.phase === "boss")) {
        player.aim = Math.atan2(enemy.y - player.y, enemy.x - player.x);
        this.core.performAutoAttack(player.userId);
      }
    }
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

  private distantAiFollowAnchor(player: CorePlayer, leader: CorePlayer): Readonly<{ x: number; y: number }> | null {
    const distance = Math.hypot(leader.x - player.x, leader.y - player.y);
    const playerRoom = this.core.rooms.get(player.roomId);
    const leaderRoom = this.core.rooms.get(leader.roomId);
    const rects = this.core.authoredWorld
      ? this.core.authoredWalkable()
      : playerRoom?.zone === leaderRoom?.zone ? this.core.zoneWorlds.get(playerRoom?.zone ?? 1)?.rects : null;
    if (!rects) return null;

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
    const points = connection.from === player.roomId ? connection.points : [...connection.points].reverse();
    const existing = this.partyNavigation.get(player.userId);
    const navigation = existing && existing.from === player.roomId && existing.to === nextRoomId
      ? existing
      : {
          from: player.roomId,
          to: nextRoomId,
          // The room id remains the source room while an actor is physically
          // inside its corridor. Restarting at point zero would send an actor
          // that already passed the doorway back in the opposite direction.
          waypointIndex: this.furthestReachableConnectionPoint(player.x, player.y, points),
        };
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
