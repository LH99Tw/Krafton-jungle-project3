import { ArraySchema, MapSchema, Schema, type, view } from "@colyseus/schema";
import { PROTOCOL_VERSION } from "@five-days/protocol";

export const PLAYER_TRANSFORM_VIEW = 1;

class EquipmentSummaryState extends Schema {
  @type("string") weaponId = "";
  @type("string") weaponRarity = "";
  @type("string") armorId = "";
  @type("string") armorRarity = "";
  @type("string") accessoryId = "";
  @type("string") accessoryRarity = "";
  @type("number") attackBonus = 0;
  @type("number") maxHpBonus = 0;
  @type("number") defenseBonus = 0;
  @type("number") attackSpeedBonus = 0;
}

export class UpgradeChoiceState extends Schema {
  @type("string") upgradeId = "";
  @type("string") name = "";
  @type("string") description = "";
  @type("string") rarity = "normal";
  @type("number") stack = 0;
  @type("number") maxStacks = 1;
  @type("number") order = 0;
}

class PlayerUpgradeDraftState extends Schema {
  @type("string") draftId = "";
  @type("number") level = 0;
  @type("boolean") active = false;
  @type("number") expiresAt = 0;
  @type([UpgradeChoiceState]) choices = new ArraySchema<UpgradeChoiceState>();
}

export class PlayerState extends Schema {
  @type("string") userId = "";
  @type("string") displayName = "";
  @type("string") heroClass = "swordsman";
  @type("string") roomId = "";
  @view(PLAYER_TRANSFORM_VIEW)
  @type("number") x = 0;
  @view(PLAYER_TRANSFORM_VIEW)
  @type("number") y = 0;
  @view(PLAYER_TRANSFORM_VIEW)
  @type("number") aim = 0;
  @type("number") hp = 0;
  @type("number") maxHp = 0;
  @type("number") level = 1;
  @type("number") teamPower = 0;
  @type("number") attackDamage = 0;
  @type("number") defense = 0;
  @type("number") criticalChance = 0;
  @type("number") criticalDamage = 150;
  @type("number") attacksPerSecond = 0;
  @type("number") attackRange = 0;
  @type("number") moveSpeed = 0;
  @type("number") qCooldown = 0;
  @type("number") eCooldown = 0;
  @type("number") dashCooldown = 0;
  @type("number") skillSequence = 0;
  @type("string") lastSkillId = "";
  @type("number") skillOriginX = 0;
  @type("number") skillOriginY = 0;
  @type("number") skillTargetX = 0;
  @type("number") skillTargetY = 0;
  @type("number") skillRadius = 0;
  @type("number") damage = 0;
  @type("number") bossDamage = 0;
  @type("number") kills = 0;
  @type("number") deaths = 0;
  @type("number") structuresBuilt = 0;
  @type("number") goldSpent = 0;
  @type("number") gatesDestroyed = 0;
  @type("number") attackSequence = 0;
  @type("string") attackTargetId = "";
  @type("boolean") attackCritical = false;
  @type("boolean") alive = true;
  @type("number") respawnRemaining = 0;
  @type("boolean") ready = false;
  @type("boolean") connected = true;
  @type(EquipmentSummaryState) equipment = new EquipmentSummaryState();
  @view()
  @type(PlayerUpgradeDraftState) upgradeDraft = new PlayerUpgradeDraftState();
}

export class RoomState extends Schema {
  @type("string") id = "";
  @type("number") zone = 1;
  @type("number") gridX = 0;
  @type("number") gridY = 0;
  @type("string") kind = "empty";
  @type("number") depth = 0;
  @type("boolean") discovered = false;
  @type("boolean") cleared = false;
}

export class DoorState extends Schema {
  @type("string") id = "";
  @type("number") zone = 1;
  @type("string") fromRoomId = "";
  @type("string") toRoomId = "";
  @type("boolean") open = true;
  @type("boolean") locked = false;
}

export class EnemyState extends Schema {
  @type("string") id = "";
  @type("string") kind = "grunt";
  @type("string") behavior = "static";
  @type("string") roomId = "";
  @type("string") spawnRoomId = "";
  @type("string") targetId = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") hp = 0;
  @type("number") maxHp = 0;
  @type("boolean") alive = true;
  @type("string") patternKind = "fan";
  @type("string") patternPhase = "idle";
  @type("number") patternRemaining = 0;
  @type("number") patternIndex = 0;
  @type("number") attackSequence = 0;
}

export class WaypointState extends Schema {
  @type("string") id = "";
  @type("string") roomId = "";
  @type("string") kind = "central";
  @type("string") destinationId = "";
  @type("boolean") active = false;
  @type("number") requiredPlayers = 0;
  @type("number") holdingPlayers = 0;
  @type("number") holdProgress = 0;
  @type("number") holdDurationMs = 5000;
}

export class StructureState extends Schema {
  @type("string") id = "";
  @type("string") roomId = "";
  @type("string") kind = "turret";
  @type("string") ownerUserId = "";
  @type("number") gridX = 0;
  @type("number") gridY = 0;
  @type("number") level = 1;
  @type("number") hp = 0;
  @type("number") maxHp = 0;
}

export class DropState extends Schema {
  @type("string") id = "";
  @type("string") ownerUserId = "";
  @type("string") roomId = "";
  @type("string") itemId = "";
  @type("string") slot = "weapon";
  @type("string") rarity = "normal";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") specialOptionCount = 0;
  @type("boolean") claimed = false;
}

export class PartyRoomState extends Schema {
  @type("number") protocolVersion = PROTOCOL_VERSION;
  @type("string") matchId = "";
  @type("string") seed = "";
  @type("string") phase = "lobby";
  @type("string") resultState = "";
  @type("string") resultReason = "";
  @type("number") currentZone = 1;
  @type("number") day = 1;
  @type("number") serverTime = 0;
  @type("number") elapsed = 0;
  @type("number") phaseEndsAt = 0;
  @type("number") baseHp = 900;
  @type("number") baseMaxHp = 900;
  @type("number") gold = 100;
  @type("number") teamLevel = 1;
  @type("number") teamXp = 0;
  @type("number") teamXpToNext = 0;
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type({ map: RoomState }) rooms = new MapSchema<RoomState>();
  @type({ map: DoorState }) doors = new MapSchema<DoorState>();
  @view()
  @type({ map: EnemyState }) enemies = new MapSchema<EnemyState>();
  @type({ map: WaypointState }) waypoints = new MapSchema<WaypointState>();
  @type({ map: StructureState }) structures = new MapSchema<StructureState>();
  @view()
  @type({ map: DropState }) drops = new MapSchema<DropState>();
}

export class LobbyPlayerState extends Schema {
  @type("string") userId = "";
  @type("string") displayName = "";
  @type("boolean") ready = false;
  @type("string") heroClass = "";
  @type("boolean") connected = true;
  @type("boolean") inGame = false;
  @type("number") joinedAt = 0;
  @type("boolean") isAi = false;
}

export class LobbyRoomState extends Schema {
  @type("string") roomName = "";
  @type("string") hostId = "";
  @type("string") phase = "waiting";
  @type("string") sessionMode = "prototype";
  @type("string") difficulty = "normal";
  @type({ map: LobbyPlayerState }) players = new MapSchema<LobbyPlayerState>();
}
