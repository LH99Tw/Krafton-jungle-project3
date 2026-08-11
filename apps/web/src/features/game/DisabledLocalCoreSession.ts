import type { InputFrame, WorldFrame } from "@five-days/protocol";
import type { CoreWorldDefinition } from "@five-days/game-core";
import type { NetworkWorldSnapshot, UpgradeChoice } from "../../game/domain/types";

const unavailable = (): never => {
  throw new Error("This development-only runtime is unavailable in production.");
};

export const localCoreSession = {
  start(_world: CoreWorldDefinition, _localUserId: string): NetworkWorldSnapshot {
    void _world; void _localUserId; return unavailable();
  },
  stop(): void {},
  tick(_deltaMs: number, _input: Readonly<{ x: number; y: number; aim: number; buttons: number }>): {
    snapshot: NetworkWorldSnapshot;
    frame: WorldFrame;
    inputFrame: InputFrame;
  } { void _deltaMs; void _input; return unavailable(); },
  chooseUpgrade(_draftId: string, _upgradeId: UpgradeChoice["id"]): boolean {
    void _draftId; void _upgradeId; return unavailable();
  },
  equip(_dropId: string): boolean { void _dropId; return unavailable(); },
  recall(): boolean { return unavailable(); },
  interact(_targetId: string): boolean { void _targetId; return unavailable(); },
  requestTravel(_waypointId: string, _destinationId: string): boolean {
    void _waypointId; void _destinationId; return unavailable();
  },
};
