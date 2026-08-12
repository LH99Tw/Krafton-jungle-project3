"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import {
  cellIndexAt,
  computeVisibilityPolygon,
  createWallSpatialIndex,
  explorationPercent,
  isExplored,
} from "@five-days/game-core";
import { NIGHT_PLAYER_VISION_RADIUS } from "@five-days/protocol";
import type { MiniMapSnapshot, PartyMemberSnapshot, Phase } from "@/src/game/domain/types";

const PLAYER_COLORS = ["#72e6bd", "#ff7f9f", "#85baff", "#f1ce70", "#c79cff", "#ff9f66"];
const DYNAMIC_FRAME_MS = 1_000 / 30;
const VISION_RADIUS_CHANGE_PER_SECOND = 220;
const DEFAULT_VIEW: MiniMapView = { zoom: 1, centerX: null, centerY: null };

type RoomMiniMapProps = {
  minimap: MiniMapSnapshot | null;
  party: PartyMemberSnapshot[];
  phase: Phase;
  embed?: boolean;
};

export function RoomMiniMap(props: RoomMiniMapProps) {
  return <RoomMiniMapContent key={props.minimap?.geometry.areaId ?? "loading"} {...props} />;
}

function RoomMiniMapContent({ minimap, party, phase, embed = false }: RoomMiniMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const positionsRef = useRef(new Map<string, { x: number; y: number }>());
  const visionRadiusRef = useRef<number | null>(null);
  const partyRef = useRef(party);
  const viewRef = useRef<MiniMapView>({ ...DEFAULT_VIEW });
  const panRef = useRef<MiniMapPan | null>(null);
  const [isPanning, setIsPanning] = useState(false);
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
    let lastFocusSignature = "";
    let lastViewSignature = "";
    let previousDrawAt = 0;

    const draw = (time: number) => {
      if (stopped) return;
      if (document.hidden || time - lastFrameAt < DYNAMIC_FRAME_MS) {
        frame = requestAnimationFrame(draw);
        return;
      }
      const elapsedSeconds = previousDrawAt === 0 ? 0 : Math.min(0.1, Math.max(0, (time - previousDrawAt) / 1_000));
      previousDrawAt = time;
      lastFrameAt = time;
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      const currentParty = partyRef.current;
      const targetVisionRadius = phase === "night" ? NIGHT_PLAYER_VISION_RADIUS : minimap.geometry.visionRadius;
      visionRadiusRef.current ??= targetVisionRadius;
      const visionStep = VISION_RADIUS_CHANGE_PER_SECOND * elapsedSeconds;
      if (visionRadiusRef.current < targetVisionRadius) visionRadiusRef.current = Math.min(targetVisionRadius, visionRadiusRef.current + visionStep);
      else if (visionRadiusRef.current > targetVisionRadius) visionRadiusRef.current = Math.max(targetVisionRadius, visionRadiusRef.current - visionStep);
      const visionSettled = visionRadiusRef.current === targetVisionRadius;
      const focus = minimapFocus(minimap, currentParty);
      const view = viewRef.current;
      const followsPlayer = view.centerX === null || view.centerY === null;
      const focusSignature = followsPlayer && focus ? `${Math.round(focus.x / 8)}:${Math.round(focus.y / 8)}` : followsPlayer ? "full" : "manual";
      const viewSignature = `${view.zoom.toFixed(4)}:${view.centerX?.toFixed(2) ?? "follow"}:${view.centerY?.toFixed(2) ?? "follow"}`;
      const partySignature = currentParty.map((member) => `${member.userId}:${member.connected ? 1 : 0}:${member.alive ? 1 : 0}:${member.roomId}:${member.x.toFixed(1)}:${member.y.toFixed(1)}`).join("|");
      const settled = currentParty.every((member) => {
        const position = positionsRef.current.get(member.userId);
        return !position || Math.hypot(member.x - position.x, member.y - position.y) < 0.25;
      });
      if (partySignature === lastPartySignature && settled && visionSettled && width === lastWidth && height === lastHeight && focusSignature === lastFocusSignature && viewSignature === lastViewSignature) {
        frame = requestAnimationFrame(draw);
        return;
      }
      lastPartySignature = partySignature;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      if (lastWidth !== width || lastHeight !== height || focusSignature !== lastFocusSignature || viewSignature !== lastViewSignature) {
        lastWidth = width;
        lastHeight = height;
        lastFocusSignature = focusSignature;
        lastViewSignature = viewSignature;
        staticCanvas.width = width;
        staticCanvas.height = height;
        renderStaticMap(staticCanvas, rect.width, rect.height, dpr, minimap, focus, view);
      }
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, width, height);
      context.drawImage(staticCanvas, 0, 0);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderDynamicMap(context, rect.width, rect.height, minimap, currentParty, positionsRef.current, reducedMotion, wallIndex, focus, view, visionRadiusRef.current);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => { stopped = true; cancelAnimationFrame(frame); };
  }, [minimap, phase]);

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!minimap) return;
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const focus = minimapFocus(minimap, partyRef.current);
    const current = viewRef.current;
    const currentTransform = mapTransform(rect.width, rect.height, minimap, focus, current);
    const baseTransform = mapTransform(rect.width, rect.height, minimap, focus, DEFAULT_VIEW);
    const fullScale = fullMapScale(rect.width, rect.height, minimap);
    const minimumZoom = Math.min(1, fullScale / baseTransform.scale);
    const nextZoom = clamp(current.zoom * Math.exp(-event.deltaY * 0.0015), minimumZoom, 3);
    if (Math.abs(nextZoom - current.zoom) < 0.0001) return;

    const cursorX = event.clientX - rect.left;
    const cursorY = event.clientY - rect.top;
    const worldX = (cursorX - currentTransform.offsetX) / currentTransform.scale;
    const worldY = (cursorY - currentTransform.offsetY) / currentTransform.scale;
    const nextScale = baseTransform.scale * nextZoom;
    const nextCenter = clampViewCenter(
      worldX - (cursorX - rect.width / 2) / nextScale,
      worldY - (cursorY - rect.height / 2) / nextScale,
      nextScale,
      rect.width,
      rect.height,
      minimap,
    );
    viewRef.current = { zoom: nextZoom, centerX: nextCenter.x, centerY: nextCenter.y };
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!minimap || event.button !== 1) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    panRef.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY };
    setIsPanning(true);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    const canvas = canvasRef.current;
    if (!minimap || !canvas || !pan || pan.pointerId !== event.pointerId) return;
    event.preventDefault();
    const deltaX = event.clientX - pan.clientX;
    const deltaY = event.clientY - pan.clientY;
    pan.clientX = event.clientX;
    pan.clientY = event.clientY;
    const rect = canvas.getBoundingClientRect();
    const current = viewRef.current;
    const focus = minimapFocus(minimap, partyRef.current);
    const currentTransform = mapTransform(rect.width, rect.height, minimap, focus, current);
    const center = viewCenter(minimap, focus, current);
    const nextCenter = clampViewCenter(
      center.x - deltaX / currentTransform.scale,
      center.y - deltaY / currentTransform.scale,
      currentTransform.scale,
      rect.width,
      rect.height,
      minimap,
    );
    viewRef.current = { ...current, centerX: nextCenter.x, centerY: nextCenter.y };
  };

  const finishPanning = (event: PointerEvent<HTMLDivElement>) => {
    if (panRef.current?.pointerId !== event.pointerId) return;
    panRef.current = null;
    setIsPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const resetView = () => {
    panRef.current = null;
    setIsPanning(false);
    viewRef.current = { ...DEFAULT_VIEW };
  };

  const content = <>
    <div
      className={`minimap-canvas-frame ${isPanning ? "is-panning" : ""}`}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPanning}
      onPointerCancel={finishPanning}
      onAuxClick={(event) => event.preventDefault()}
      onDoubleClick={resetView}
      title="휠 버튼 드래그: 지도 이동 · 더블클릭: 내 위치로 복귀"
    >
      <canvas ref={canvasRef} className="minimap-canvas" role="img" aria-label={`파티 공유 탐색 지도, ${Math.floor(percent)}% 탐색됨. 휠 버튼을 누른 채 드래그하여 다른 지역을 볼 수 있습니다.`} />
      <button
        type="button"
        className="minimap-reset-view"
        aria-label="미니맵을 내 위치 중심의 기본 보기로 되돌리기"
        title="기본 보기로 복귀"
        onClick={(event) => { event.stopPropagation(); resetView(); }}
      >
        <span aria-hidden="true">⌖</span>
      </button>
    </div>
  </>;

  return embed ? <div className="embedded-room-map">{content}</div> : <section className="room-map hud-panel">{content}</section>;
}

type Transform = Readonly<{
  scale: number;
  offsetX: number;
  offsetY: number;
  toCanvas: (x: number, y: number) => { x: number; y: number };
}>;

type MiniMapView = Readonly<{ zoom: number; centerX: number | null; centerY: number | null }>;
type MiniMapPan = { pointerId: number; clientX: number; clientY: number };

function fullMapScale(width: number, height: number, minimap: MiniMapSnapshot): number {
  const padding = 10;
  const { bounds } = minimap.geometry;
  return Math.min((width - padding * 2) / bounds.width, (height - padding * 2) / bounds.height);
}

function mapCenter(minimap: MiniMapSnapshot, focus: { x: number; y: number } | null): { x: number; y: number } {
  const { bounds } = minimap.geometry;
  return focus ?? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function viewCenter(minimap: MiniMapSnapshot, focus: { x: number; y: number } | null, view: MiniMapView): { x: number; y: number } {
  return view.centerX === null || view.centerY === null ? mapCenter(minimap, focus) : { x: view.centerX, y: view.centerY };
}

function mapTransform(width: number, height: number, minimap: MiniMapSnapshot, focus: { x: number; y: number } | null = null, view: MiniMapView = DEFAULT_VIEW): Transform {
  const fullScale = fullMapScale(width, height, minimap);
  const baseScale = focus
    ? Math.min(fullScale * 4, Math.max(fullScale * 2.35, Math.min(width, height) / (minimap.geometry.visionRadius * 2.4)))
    : fullScale;
  const scale = baseScale * view.zoom;
  const { x: centerX, y: centerY } = viewCenter(minimap, focus, view);
  const offsetX = width / 2 - centerX * scale;
  const offsetY = height / 2 - centerY * scale;
  return { scale, offsetX, offsetY, toCanvas: (x, y) => ({ x: offsetX + x * scale, y: offsetY + y * scale }) };
}

function clampViewCenter(x: number, y: number, scale: number, width: number, height: number, minimap: MiniMapSnapshot): { x: number; y: number } {
  const { bounds } = minimap.geometry;
  const halfWorldWidth = Math.min(bounds.width / 2, width / Math.max(scale, 0.0001) / 2);
  const halfWorldHeight = Math.min(bounds.height / 2, height / Math.max(scale, 0.0001) / 2);
  return {
    x: clamp(x, bounds.x + halfWorldWidth, bounds.x + bounds.width - halfWorldWidth),
    y: clamp(y, bounds.y + halfWorldHeight, bounds.y + bounds.height - halfWorldHeight),
  };
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
  focus: { x: number; y: number } | null,
  view: MiniMapView,
): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  const { geometry, explorationMask } = minimap;
  const transform = mapTransform(width, height, minimap, focus, view);
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
  focus: { x: number; y: number } | null,
  view: MiniMapView,
  visionRadius: number,
): void {
  const { geometry } = minimap;
  const transform = mapTransform(width, height, minimap, focus, view);
  const visibleParty = party.filter((member) => member.connected && member.alive
    && (geometry.areaId === "editor" || areaForRoom(member.roomId) === geometry.areaId));

  context.save();
  context.clip(surfacePath(minimap, transform));
  for (const member of visibleParty) {
    const polygon = computeVisibilityPolygon(member, visionRadius, wallIndex);
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
    const radius = visionRadius * transform.scale;
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

function minimapFocus(minimap: MiniMapSnapshot, party: PartyMemberSnapshot[]): { x: number; y: number } | null {
  const eligible = party.filter((member) => member.connected && member.alive
    && (minimap.geometry.areaId === "editor" || areaForRoom(member.roomId) === minimap.geometry.areaId));
  const member = eligible.find((candidate) => candidate.isLocal) ?? eligible[0];
  return member ? { x: member.x, y: member.y } : null;
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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
