import { MapSchema, Schema, type } from "@colyseus/schema";

export class PlayerState extends Schema {
  @type("string") userId = "";
  @type("string") displayName = "";
  @type("string") heroClass = "swordsman";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") aim = 0;
  @type("number") hp = 0;
  @type("number") maxHp = 0;
  @type("number") level = 1;
  @type("number") teamPower = 0;
  @type("boolean") ready = false;
  @type("boolean") connected = true;
}

export class PartyRoomState extends Schema {
  @type("number") protocolVersion = 1;
  @type("string") matchId = "";
  @type("string") phase = "lobby";
  @type("number") day = 1;
  @type("number") serverTime = 0;
  @type("number") phaseEndsAt = 0;
  @type("number") baseHp = 900;
  @type("number") gold = 100;
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
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
