"use client";

import { useEffect, useState } from "react";
import type { GameSnapshot } from "@/src/game/domain/types";
import { gameBridge } from "@/src/game/runtime/GameBridge";
import { RoomMiniMap } from "../RoomMiniMap";

function barStyle(value: number, max: number): React.CSSProperties {
  return { "--bar-value": `${max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0}%` } as React.CSSProperties;
}

export function ExplorationHud({ snapshot }: { snapshot: GameSnapshot }) {
  const [mapExpanded, setMapExpanded] = useState(false);
  useEffect(() => {
    if (!mapExpanded) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMapExpanded(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mapExpanded]);

  const requestTravel = (waypointId: string, destinationId: string) => gameBridge.command({
    type: "travel",
    waypointId,
    destinationId,
  });

  return (
    <section className={`exploration-reliquary ${mapExpanded ? "is-map-expanded" : ""}`} aria-label="탐색 지도 및 기지 내구도">
      <div className="exploration-reliquary-inner">
        <RoomMiniMap
          minimap={snapshot.minimap}
          party={snapshot.party}
          waypoint={snapshot.waypoint}
          currentRoomId={snapshot.currentRoomId}
          expanded={mapExpanded}
          onExpandedChange={setMapExpanded}
          onWaypointTravel={requestTravel}
          embed
        />
        <div className="map-tactical-footer">
          <div className="base-health">
            <span><b>베이스 내구도</b><small>{Math.ceil(snapshot.baseHp)} / {snapshot.baseMaxHp}</small></span>
            <span className="base-bar" style={barStyle(snapshot.baseHp, snapshot.baseMaxHp)} />
          </div>
          {snapshot.bossAvailable && snapshot.waypoint.nearby && (
            <button className="waypoint-rally" type="button" onClick={() => requestTravel(snapshot.waypoint.id ?? "", snapshot.waypoint.destinationId)}>
              <span>마왕방 이동</span>
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
