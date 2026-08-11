import { WAYPOINT_HOLD_SECONDS, isPlayerOnWaypoint, waypointId, type CoreRoomId, type CoreWaypoint, type TravelIntent } from "../../v02/simulation";
import type { GameCore } from "../GameCore";
import { SIMULATION_EPSILON } from "../constants";
import type { CorePlayer } from "../types";

/**
 * Owns waypoint travel: eligibility, hold progress, destination completion,
 * boss-room arrival, and recall. Mutates players/waypoints through the owning
 * {@link GameCore}.
 */
export class TravelDirector {
  private travelIntent: TravelIntent | null = null;

  constructor(private readonly core: GameCore) {}

  get active(): Readonly<TravelIntent> | null {
    return this.travelIntent ? { ...this.travelIntent } : null;
  }

  request(userId: string, waypointIdValue: string, destinationId?: string): boolean {
    const requester = this.core.players.get(userId);
    const waypoint = this.core.waypoints.get(waypointIdValue);
    if (!requester || !requester.connected || !requester.alive || !waypoint?.active) return false;
    if (!isPlayerOnWaypoint(requester, waypoint)) return false;

    const destination = destinationId || waypoint.destinationId;
    if (!this.isAllowedDestination(waypoint, destination)) return false;
    return this.beginTravel(userId, waypoint, destination);
  }

  recall(userId: string): boolean {
    const player = this.core.players.get(userId);
    if (!player || !player.connected || !player.alive || this.core.phase === "boss") return false;
    const source = [...this.core.waypoints.values()].find((waypoint) => (
      waypoint.active && isPlayerOnWaypoint(player, waypoint)
    ));
    if (!source) return false;
    const baseWaypointId = waypointId(this.core.startRoomId(), "start");
    if (source.id === baseWaypointId) return false;
    return this.beginTravel(userId, source, baseWaypointId);
  }

  /** Marks the waypoint for a destroyed gate room and its destination active. */
  unlockGate(gateRoomId: CoreRoomId): void {
    const gateWaypoint = [...this.core.waypoints.values()].find((waypoint) => waypoint.roomId === gateRoomId);
    if (!gateWaypoint) return;
    gateWaypoint.active = true;
    const next = this.core.waypoints.get(gateWaypoint.destinationId);
    if (next) next.active = true;
  }

  cancel(): void {
    if (this.travelIntent) {
      const waypoint = this.core.waypoints.get(this.travelIntent.waypointId);
      if (waypoint) {
        waypoint.requiredPlayers = 0;
        waypoint.holdingPlayers = 0;
        waypoint.holdProgress = 0;
      }
    }
    this.travelIntent = null;
  }

  update(delta: number): void {
    const intent = this.travelIntent;
    if (!intent) return;
    const waypoint = this.core.waypoints.get(intent.waypointId);
    const eligible = this.eligiblePlayers();
    const holding = waypoint ? eligible.filter((player) => isPlayerOnWaypoint(player, waypoint)) : [];
    if (!waypoint?.active || eligible.length === 0 || holding.length !== eligible.length) {
      this.cancel();
      return;
    }
    intent.elapsed += delta;
    waypoint.requiredPlayers = eligible.length;
    waypoint.holdingPlayers = holding.length;
    waypoint.holdProgress = Math.min(1, intent.elapsed / WAYPOINT_HOLD_SECONDS);
    if (intent.elapsed + SIMULATION_EPSILON >= WAYPOINT_HOLD_SECONDS) {
      const followers = [...this.core.players.values()].filter((player) => player.alive && player.aiRole === "follower");
      this.completeTravel(intent.destinationId, [...eligible, ...followers]);
    }
  }

  private beginTravel(userId: string, waypoint: CoreWaypoint, destination: string): boolean {
    const eligible = this.eligiblePlayers();
    if (eligible.length === 0 || eligible.some((player) => !isPlayerOnWaypoint(player, waypoint))) return false;

    if (this.travelIntent?.waypointId === waypoint.id && this.travelIntent.destinationId === destination) return true;
    this.cancel();
    this.travelIntent = { requestedBy: userId, waypointId: waypoint.id, destinationId: destination, elapsed: 0 };
    waypoint.requiredPlayers = eligible.length;
    waypoint.holdingPlayers = eligible.length;
    waypoint.holdProgress = 0;
    return true;
  }

  private completeTravel(destinationId: string, players: readonly CorePlayer[]): void {
    if (destinationId === this.core.bossRoomId()) {
      const bossRoomId = this.core.bossRoomId();
      const boss = this.core.roomRectOf(bossRoomId);
      for (const player of players) {
        player.roomId = bossRoomId;
        player.x = boss.x + boss.width / 2;
        player.y = boss.y + boss.height * 0.72;
      }
      this.core.discoverRoom(bossRoomId);
      this.core.currentZone = 3;
      this.core.enterBossEncounter();
      this.cancel();
      return;
    }

    const destination = this.core.waypoints.get(destinationId);
    if (!destination?.active) {
      this.cancel();
      return;
    }
    if (destination.zone > this.core.currentZone && this.core.hasLivingGateInZone(this.core.currentZone)) {
      for (const player of players) this.core.pushZoneGateWarning(player.userId, this.core.currentZone);
      this.cancel();
      return;
    }
    for (const player of players) {
      player.roomId = destination.roomId;
      player.x = destination.x;
      player.y = destination.y;
    }
    this.core.discoverRoom(destination.roomId);
    if (destination.zone > this.core.currentZone) this.core.currentZone = destination.zone;
    this.cancel();
  }

  private eligiblePlayers(): CorePlayer[] {
    return [...this.core.players.values()].filter((player) => player.connected && player.alive && !player.aiRole);
  }

  private isAllowedDestination(source: CoreWaypoint, destinationId: string): boolean {
    if (source.kind === "gate" || source.kind === "boss") return destinationId === source.destinationId;
    const destination = this.core.waypoints.get(destinationId);
    return Boolean(destination?.active && destination.id !== source.id);
  }
}
