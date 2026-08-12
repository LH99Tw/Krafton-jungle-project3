import type { GameSnapshot } from "@/src/game/domain/types";
import { gameBridge } from "@/src/game/runtime/GameBridge";
import { RoomMiniMap } from "../RoomMiniMap";

function barStyle(value: number, max: number): React.CSSProperties {
  return { "--bar-value": `${max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0}%` } as React.CSSProperties;
}

export function ExplorationHud({ snapshot }: { snapshot: GameSnapshot }) {
  return (
    <section className="exploration-reliquary" aria-label="탐색 지도 및 기지 내구도">
      <div className="exploration-reliquary-inner">
        <RoomMiniMap
          minimap={snapshot.minimap}
          party={snapshot.party}
          embed
          sourceWaypointId={snapshot.waypoint.nearby ? snapshot.waypoint.id : null}
          onWaypointSelect={(destinationId) => {
            if (!snapshot.waypoint.id) return;
            gameBridge.command({ type: "travel", waypointId: snapshot.waypoint.id, destinationId });
          }}
        />
        <div className="map-tactical-footer">
          <div className="base-health">
            <span><b>베이스 내구도</b><small>{Math.ceil(snapshot.baseHp)} / {snapshot.baseMaxHp}</small></span>
            <span className="base-bar" style={barStyle(snapshot.baseHp, snapshot.baseMaxHp)} />
          </div>
          {snapshot.bossAvailable && (
            <button className="waypoint-rally" type="button" onClick={() => gameBridge.command({
              type: "travel",
              waypointId: snapshot.waypoint.id ?? "",
              destinationId: snapshot.waypoint.destinationId,
            })}>
              <span>{snapshot.bossAvailable ? "마왕방 집결" : "웨이포인트 집결"}</span>
              <strong>{snapshot.waypoint.presentPlayers}/{snapshot.waypoint.requiredPlayers}</strong>
              {snapshot.waypoint.holdProgress > 0 && <i style={{ width: `${snapshot.waypoint.holdProgress * 100}%` }} />}
            </button>
          )}
          {snapshot.waypoint.nearby && !snapshot.bossAvailable && (
            <div className="waypoint-rally is-fast-travel" role="status">
              <span>{snapshot.waypoint.holdProgress > 0 ? "순간이동 집중 중 · 움직이면 취소" : "미니맵의 보라색 웨이포인트를 선택하세요"}</span>
              <strong>{snapshot.waypoint.holdProgress > 0 ? `${Math.ceil((1 - snapshot.waypoint.holdProgress) * 3)}초` : "3초"}</strong>
              {snapshot.waypoint.holdProgress > 0 && <i style={{ width: `${snapshot.waypoint.holdProgress * 100}%` }} />}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
