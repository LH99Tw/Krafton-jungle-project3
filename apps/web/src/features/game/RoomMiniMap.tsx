"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  cellIndexAt,
  computeVisibilityPolygon,
  createWallSpatialIndex,
  explorationPercent,
  isExplored,
} from "@five-days/game-core";
import type { MiniMapSnapshot, PartyMemberSnapshot } from "@/src/game/domain/types";

const PLAYER_COLORS = ["#72e6bd", "#ff7f9f", "#85baff", "#f1ce70", "#c79cff", "#ff9f66"];
const DYNAMIC_FRAME_MS = 1_000 / 30;

export function RoomMiniMap({ minimap, party, embed = false }: {
  minimap: MiniMapSnapshot | null;
  party: PartyMemberSnapshot[];
  embed?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const positionsRef = useRef(new Map<string, { x: number; y: number }>());
  const partyRef = useRef(party);
  const percent = useMemo(() => minimap ? explorationPercent(minimap.geometry, minimap.explorationMask) : 0, [minimap]);

  useEffect(() => {
    partyRef.current = party;
  }, [party]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !minimap) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const wallIndex = createWallSpatialIndex(minimap.geometry.wallSegments);
    const staticCanvas = document.createElement("canvas");
    let frame = 0;
    let stopped = false;
    let lastFrameAt = 0;
    let lastWidth = 0;
    let lastHeight = 0;
    let lastPartySignature = "";

    const draw = (time: number) => {
      if (stopped) return;
      if (document.hidden || time - lastFrameAt < DYNAMIC_FRAME_MS) {
        frame = requestAnimationFrame(draw);
        return;
      }
      lastFrameAt = time;
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      const currentParty = partyRef.current;
      const partySignature = currentParty.map((member) => `${member.userId}:${member.connected ? 1 : 0}:${member.alive ? 1 : 0}:${member.roomId}:${member.x.toFixed(1)}:${member.y.toFixed(1)}`).join("|");
      const settled = currentParty.every((member) => {
        const position = positionsRef.current.get(member.userId);
        return !position || Math.hypot(member.x - position.x, member.y - position.y) < 0.25;
      });
      if (partySignature === lastPartySignature && settled && width === lastWidth && height === lastHeight) {
        frame = requestAnimationFrame(draw);
        return;
      }
      lastPartySignature = partySignature;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      if (lastWidth !== width || lastHeight !== height) {
        lastWidth = width;
        lastHeight = height;
        staticCanvas.width = width;
        staticCanvas.height = height;
        renderStaticMap(staticCanvas, rect.width, rect.height, dpr, minimap);
      }
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, width, height);
      context.drawImage(staticCanvas, 0, 0);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderDynamicMap(context, rect.width, rect.height, minimap, currentParty, positionsRef.current, reducedMotion, wallIndex);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => { stopped = true; cancelAnimationFrame(frame); };
  }, [minimap]);

  const content = <>
    <div className="hud-panel-title">
      <span>{minimap?.geometry.areaId === "official-map" ? "OFFICIAL MAP" : minimap?.geometry.areaId.replace("zone-", "ZONE ").toUpperCase() ?? "EXPEDITION"} · PARTY TRAIL</span>
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

type Transform = Readonly<{
  scale: number;
  offsetX: number;
  offsetY: number;
  toCanvas: (x: number, y: number) => { x: number; y: number };
}>;

function mapTransform(width: number, height: number, minimap: MiniMapSnapshot): Transform {
  const padding = 10;
  const { bounds } = minimap.geometry;
  const scale = Math.min((width - padding * 2) / bounds.width, (height - padding * 2) / bounds.height);
  const offsetX = (width - bounds.width * scale) / 2 - bounds.x * scale;
  const offsetY = (height - bounds.height * scale) / 2 - bounds.y * scale;
  return { scale, offsetX, offsetY, toCanvas: (x, y) => ({ x: offsetX + x * scale, y: offsetY + y * scale }) };
}

function surfacePath(minimap: MiniMapSnapshot, transform: Transform): Path2D {
  const result = new Path2D();
  for (const surface of minimap.geometry.surfaces) {
    surface.points.forEach((point, index) => {
      const mapped = transform.toCanvas(point.x, point.y);
      if (index === 0) result.moveTo(mapped.x, mapped.y); else result.lineTo(mapped.x, mapped.y);
    });
    result.closePath();
  }
  return result;
}

function renderStaticMap(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  dpr: number,
  minimap: MiniMapSnapshot,
): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  const { geometry, explorationMask } = minimap;
  const transform = mapTransform(width, height, minimap);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);
  context.save();
  context.clip(surfacePath(minimap, transform));
  context.fillStyle = "rgba(71, 134, 111, .34)";
  const cell = Math.max(1, geometry.cellSize * transform.scale);
  for (let index = 0; index < geometry.columns * geometry.rows; index += 1) {
    if (!isExplored(explorationMask, index)) continue;
    const column = index % geometry.columns;
    const row = Math.floor(index / geometry.columns);
    const topLeft = transform.toCanvas(
      geometry.bounds.x + column * geometry.cellSize,
      geometry.bounds.y + row * geometry.cellSize,
    );
    context.fillRect(topLeft.x, topLeft.y, cell + 0.35, cell + 0.35);
  }
  context.restore();
  for (const marker of geometry.markers) {
    if (!isExplored(explorationMask, cellIndexAt(geometry, marker.x, marker.y))) continue;
    const point = transform.toCanvas(marker.x, marker.y);
    context.fillStyle = marker.kind === "boss" ? "#ff7899" : marker.kind === "gate" ? "#efc96f" : "#92c9ff";
    context.strokeStyle = "rgba(0,0,0,.9)";
    context.lineWidth = 2;
    context.beginPath();
    context.arc(point.x, point.y, marker.kind === "boss" ? 5 : 4, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }
}

function renderDynamicMap(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  minimap: MiniMapSnapshot,
  party: PartyMemberSnapshot[],
  positions: Map<string, { x: number; y: number }>,
  reducedMotion: boolean,
  wallIndex: ReturnType<typeof createWallSpatialIndex>,
): void {
  const { geometry } = minimap;
  const transform = mapTransform(width, height, minimap);
  const visibleParty = party.filter((member) => member.connected && member.alive
    && (geometry.areaId === "editor" || areaForRoom(member.roomId) === geometry.areaId));

  context.save();
  context.clip(surfacePath(minimap, transform));
  for (const member of visibleParty) {
    const polygon = computeVisibilityPolygon(member, geometry.visionRadius, wallIndex);
    if (polygon.length < 3) continue;
    const path = new Path2D();
    polygon.forEach((point, index) => {
      const mapped = transform.toCanvas(point.x, point.y);
      if (index === 0) path.moveTo(mapped.x, mapped.y); else path.lineTo(mapped.x, mapped.y);
    });
    path.closePath();
    context.save();
    context.clip(path);
    const center = transform.toCanvas(member.x, member.y);
    const radius = geometry.visionRadius * transform.scale;
    const glow = context.createRadialGradient(center.x, center.y, 0, center.x, center.y, radius);
    glow.addColorStop(0, "rgba(176, 248, 220, .9)");
    glow.addColorStop(.88, "rgba(113, 218, 179, .58)");
    glow.addColorStop(1, "rgba(75, 151, 123, 0)");
    context.fillStyle = glow;
    context.fillRect(center.x - radius, center.y - radius, radius * 2, radius * 2);
    context.restore();
  }
  context.restore();

  for (const member of visibleParty) {
    const current = positions.get(member.userId) ?? { x: member.x, y: member.y };
    const next = reducedMotion ? { x: member.x, y: member.y } : {
      x: current.x + (member.x - current.x) * 0.35,
      y: current.y + (member.y - current.y) * 0.35,
    };
    positions.set(member.userId, next);
    const point = transform.toCanvas(next.x, next.y);
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
  if (roomId.startsWith("editor:")) return "official-map";
  if (roomId === "boss:arena") return "zone-3";
  return /^zone-(\d+)/u.exec(roomId)?.[0] ?? "";
}

function playerColor(userId: string): string {
  let hash = 2166136261;
  for (let index = 0; index < userId.length; index += 1) hash = Math.imul(hash ^ userId.charCodeAt(index), 16777619);
  return PLAYER_COLORS[Math.abs(hash) % PLAYER_COLORS.length]!;
}
