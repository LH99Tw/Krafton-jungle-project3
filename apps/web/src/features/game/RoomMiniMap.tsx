"use client";

import type { RoomMapCell } from "@/src/game/domain/types";

const ROOM_LABELS: Record<RoomMapCell["type"], string> = {
  start: "시작",
  gate: "게이트",
  resource: "자원",
  "static-monster": "몬스터",
  empty: "빈 방",
  "central-waypoint": "웨이포인트",
  "hidden-monster": "히든",
  boss: "보스",
};

export function RoomMiniMap({ rooms, zone }: { rooms: RoomMapCell[]; zone: number }) {
  const visibleRooms = rooms.filter((room) => room.zone === zone && room.visited);
  const byCoordinate = new Map(visibleRooms.map((room) => [`${room.x}:${room.y}`, room]));

  return (
    <section className="room-map hud-panel" aria-label={`구역 ${zone} 탐색 지도`}>
      <div className="hud-panel-title"><span>ZONE {String(zone).padStart(2, "0")} · ROOM MAP</span><b>{visibleRooms.length}/15</b></div>
      <div className="room-map-grid">
        {Array.from({ length: 25 }, (_, index) => {
          const x = index % 5;
          const y = Math.floor(index / 5);
          const room = byCoordinate.get(`${x}:${y}`);
          return room ? (
            <span
              key={room.id}
              className={`room-cell room-cell--${room.type} ${room.current ? "is-current" : ""} ${room.cleared ? "is-cleared" : ""}`}
              title={ROOM_LABELS[room.type]}
              aria-label={`${ROOM_LABELS[room.type]}${room.current ? ", 현재 위치" : ""}`}
            >
              {room.type === "start" ? "B" : room.type === "gate" ? "G" : room.type === "central-waypoint" ? "W" : room.type === "hidden-monster" ? "?" : ""}
            </span>
          ) : <span aria-hidden="true" className="room-cell is-unknown" key={`${x}:${y}`} />;
        })}
      </div>
      <div className="room-map-legend"><span><i className="legend-current" />현재</span><span><i className="legend-cleared" />정복</span><span><i className="legend-hidden" />히든</span></div>
    </section>
  );
}
