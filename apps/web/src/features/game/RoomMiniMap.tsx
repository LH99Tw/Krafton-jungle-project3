"use client";

import { useEffect, useMemo, useRef } from "react";
import { cellIndexAt, explorationPercent, isExplored } from "@five-days/game-core";
import type { MiniMapSnapshot, PartyMemberSnapshot } from "@/src/game/domain/types";

const PLAYER_COLORS = ["#72e6bd", "#ff7f9f", "#85baff", "#f1ce70", "#c79cff", "#ff9f66"];

export function RoomMiniMap({ minimap, party, embed = false }: {
  minimap: MiniMapSnapshot | null;
  party: PartyMemberSnapshot[];
  embed?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const positionsRef = useRef(new Map<string, { x: number; y: number }>());
  const percent = useMemo(() => minimap ? explorationPercent(minimap.geometry, minimap.explorationMask) : 0, [minimap]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !minimap) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let stopped = false;

    const draw = () => {
      if (stopped) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderMap(context, rect.width, rect.height, minimap, party, positionsRef.current, reducedMotion);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => { stopped = true; cancelAnimationFrame(frame); };
  }, [minimap, party]);

  const content = <>
    <div className="hud-panel-title">
      <span>{minimap?.geometry.areaId.replace("zone-", "ZONE ").toUpperCase() ?? "EXPEDITION"} · PARTY TRAIL</span>
      <b>{percent >= 95 ? "탐색 완료" : `${Math.floor(percent)}%`}</b>
    </div>
    <div className="minimap-canvas-frame">
      <canvas ref={canvasRef} className="minimap-canvas" role="img" aria-label={`파티 공유 탐색 지도, ${Math.floor(percent)}% 탐색됨`} />
      {!minimap && <span className="minimap-loading">탐색 지형 동기화 중</span>}
    </div>
    <div className="minimap-status" aria-hidden="true"><span><i className="trail-dot" />지나온 길</span><span><i className="vision-dot" />현재 시야</span></div>
  </>;

  return embed ? <div className="embedded-room-map">{content}</div> : <section className="room-map hud-panel">{content}</section>;
}

function renderMap(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  minimap: MiniMapSnapshot,
  party: PartyMemberSnapshot[],
  positions: Map<string, { x: number; y: number }>,
  reducedMotion: boolean,
): void {
  const { geometry, explorationMask } = minimap;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);
  const padding = 10;
  const scale = Math.min((width - padding * 2) / geometry.bounds.width, (height - padding * 2) / geometry.bounds.height);
  const offsetX = (width - geometry.bounds.width * scale) / 2 - geometry.bounds.x * scale;
  const offsetY = (height - geometry.bounds.height * scale) / 2 - geometry.bounds.y * scale;
  const toCanvas = (x: number, y: number) => ({ x: offsetX + x * scale, y: offsetY + y * scale });
  const surfacePath = new Path2D();
  for (const surface of geometry.surfaces) {
    surface.points.forEach((point, index) => {
      const mapped = toCanvas(point.x, point.y);
      if (index === 0) surfacePath.moveTo(mapped.x, mapped.y); else surfacePath.lineTo(mapped.x, mapped.y);
    });
    surfacePath.closePath();
  }

  context.save();
  context.clip(surfacePath);
  context.fillStyle = "rgba(71, 134, 111, .34)";
  const brush = Math.max(2.5, geometry.cellSize * scale * 0.74);
  for (let index = 0; index < geometry.columns * geometry.rows; index += 1) {
    if (!isExplored(explorationMask, index)) continue;
    const column = index % geometry.columns;
    const row = Math.floor(index / geometry.columns);
    const point = toCanvas(
      geometry.bounds.x + (column + 0.5) * geometry.cellSize,
      geometry.bounds.y + (row + 0.5) * geometry.cellSize,
    );
    context.beginPath();
    context.arc(point.x, point.y, brush, 0, Math.PI * 2);
    context.fill();
  }

  const visibleParty = party.filter((member) => member.connected && member.alive
    && (geometry.areaId === "editor" || areaForRoom(member.roomId) === geometry.areaId));
  for (const member of visibleParty) {
    const point = toCanvas(member.x, member.y);
    const radius = Math.max(24, 330 * scale);
    const glow = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius);
    glow.addColorStop(0, "rgba(176, 248, 220, .9)");
    glow.addColorStop(.48, "rgba(113, 218, 179, .58)");
    glow.addColorStop(1, "rgba(75, 151, 123, 0)");
    context.fillStyle = glow;
    context.fillRect(point.x - radius, point.y - radius, radius * 2, radius * 2);
  }
  context.restore();

  for (const marker of geometry.markers) {
    if (!isExplored(explorationMask, cellIndexAt(geometry, marker.x, marker.y))) continue;
    const point = toCanvas(marker.x, marker.y);
    context.fillStyle = marker.kind === "boss" ? "#ff7899" : marker.kind === "gate" ? "#efc96f" : "#92c9ff";
    context.strokeStyle = "rgba(0,0,0,.9)";
    context.lineWidth = 2;
    context.beginPath();
    context.arc(point.x, point.y, marker.kind === "boss" ? 5 : 4, 0, Math.PI * 2);
    context.fill(); context.stroke();
  }

  for (const member of visibleParty) {
    const current = positions.get(member.userId) ?? { x: member.x, y: member.y };
    const next = reducedMotion ? { x: member.x, y: member.y } : {
      x: current.x + (member.x - current.x) * 0.18,
      y: current.y + (member.y - current.y) * 0.18,
    };
    positions.set(member.userId, next);
    const point = toCanvas(next.x, next.y);
    context.shadowColor = playerColor(member.userId);
    context.shadowBlur = 9;
    context.fillStyle = playerColor(member.userId);
    context.beginPath(); context.arc(point.x, point.y, 4.2, 0, Math.PI * 2); context.fill();
    context.shadowBlur = 0;
    if (member.isLocal) {
      context.strokeStyle = "#fff"; context.lineWidth = 1.35;
      context.beginPath(); context.arc(point.x, point.y, 6.2, 0, Math.PI * 2); context.stroke();
    }
  }
}

function areaForRoom(roomId: string): string {
  if (roomId === "boss:arena") return "zone-3";
  return /^zone-(\d+)/u.exec(roomId)?.[0] ?? "";
}

function playerColor(userId: string): string {
  let hash = 2166136261;
  for (let index = 0; index < userId.length; index += 1) hash = Math.imul(hash ^ userId.charCodeAt(index), 16777619);
  return PLAYER_COLORS[Math.abs(hash) % PLAYER_COLORS.length];
}
