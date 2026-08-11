"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  cloneEditorMap,
  DEFAULT_EDITOR_MAP,
  EDITOR_MAP_STORAGE_KEY,
  validateEditorMap,
  type EditorAssetTheme,
  type EditorMapDefinition,
  type EditorRoom,
  type EditorRoomType,
} from "@/src/game/domain/mapEditor";

const CELL = 50;
const ROOM_TYPES: Array<{ type: EditorRoomType; label: string; mark: string }> = [
  { type: "empty", label: "일반 방", mark: "◇" },
  { type: "resource", label: "자원 방", mark: "◆" },
  { type: "static-monster", label: "몬스터 방", mark: "⚔" },
  { type: "gate", label: "몬스터 게이트", mark: "♜" },
  { type: "boss", label: "보스룸", mark: "♛" },
  { type: "start", label: "시작 베이스", mark: "⌂" },
];
const THEMES: Array<{ id: EditorAssetTheme; label: string; image: string }> = [
  { id: "forest", label: "녹음 지대", image: "/Asset/zone-1-vegetation.png" },
  { id: "marsh", label: "침수 습지", image: "/Asset/zone-2-vegetation.png" },
  { id: "wastes", label: "마력 황무지", image: "/Asset/zone-3-vegetation.png" },
];

type Tool = "select" | "room" | "connect";

function loadInitialMap(): EditorMapDefinition {
  if (typeof window === "undefined") return cloneEditorMap(DEFAULT_EDITOR_MAP);
  try {
    const stored = window.localStorage.getItem(EDITOR_MAP_STORAGE_KEY);
    if (!stored) return cloneEditorMap(DEFAULT_EDITOR_MAP);
    const parsed = JSON.parse(stored) as EditorMapDefinition;
    if (parsed.version === 1 && Array.isArray(parsed.rooms) && Array.isArray(parsed.connections)) return parsed;
  } catch {
    // Corrupt local drafts fall back to the bundled starter map.
  }
  return cloneEditorMap(DEFAULT_EDITOR_MAP);
}

export function MapEditorScreen({ onBack, onPlay }: { onBack: () => void; onPlay: (map: EditorMapDefinition) => void }) {
  const [map, setMap] = useState(loadInitialMap);
  const [tool, setTool] = useState<Tool>("select");
  const [placementType, setPlacementType] = useState<EditorRoomType>("empty");
  const [selectedId, setSelectedId] = useState<string>(() => map.rooms[0]?.id ?? "");
  const [connectionStart, setConnectionStart] = useState<string | null>(null);
  const dragRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const failures = useMemo(() => validateEditorMap(map), [map]);
  const selected = map.rooms.find((room) => room.id === selectedId) ?? null;

  useEffect(() => {
    window.localStorage.setItem(EDITOR_MAP_STORAGE_KEY, JSON.stringify(map));
  }, [map]);

  const updateRoom = (id: string, patch: Partial<EditorRoom>) => {
    setMap((current) => ({ ...current, rooms: current.rooms.map((room) => room.id === id ? { ...room, ...patch } : room) }));
  };

  const addRoom = (x: number, y: number) => {
    const id = `room-${Date.now().toString(36)}`;
    const typeInfo = ROOM_TYPES.find((candidate) => candidate.type === placementType);
    const room: EditorRoom = {
      id,
      name: typeInfo?.label ?? "새 방",
      type: placementType,
      asset: "forest",
      x: Math.max(0, Math.round(x / CELL)),
      y: Math.max(0, Math.round(y / CELL)),
      width: placementType === "boss" ? 4 : 3,
      height: placementType === "boss" ? 4 : 3,
    };
    setMap((current) => ({ ...current, rooms: [...current.rooms, room] }));
    setSelectedId(id);
    setTool("select");
  };

  const connectRoom = (roomId: string) => {
    if (!connectionStart) {
      setConnectionStart(roomId);
      return;
    }
    if (connectionStart === roomId) return setConnectionStart(null);
    const duplicate = map.connections.some((connection) =>
      (connection.from === connectionStart && connection.to === roomId)
      || (connection.from === roomId && connection.to === connectionStart));
    if (!duplicate) {
      setMap((current) => ({
        ...current,
        connections: [...current.connections, { id: `path-${Date.now().toString(36)}`, from: connectionStart, to: roomId }],
      }));
    }
    setConnectionStart(null);
  };

  const pointInSvg = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * 1300 / rect.width, y: (event.clientY - rect.top) * 700 / rect.height };
  };

  const roomCenter = (room: EditorRoom) => ({ x: (room.x + room.width / 2) * CELL, y: (room.y + room.height / 2) * CELL });

  return (
    <main className="map-editor-screen">
      <header className="map-editor-header">
        <button type="button" className="editor-back" onClick={onBack}>← 원정대 화면</button>
        <div>
          <span>LOCAL WORLD FORGE</span>
          <input aria-label="맵 이름" value={map.title} maxLength={40} onChange={(event) => setMap({ ...map, title: event.target.value })} />
        </div>
        <div className="editor-save-state"><i /> 브라우저에 자동 저장됨</div>
        <button type="button" className="editor-play" disabled={failures.length > 0} onClick={() => onPlay(cloneEditorMap(map))}>임시 적용 · 플레이 <b>▶</b></button>
      </header>

      <div className="map-editor-layout">
        <aside className="editor-tools" aria-label="맵 제작 도구">
          <div className="editor-section-title"><span>01</span><strong>제작 도구</strong></div>
          <div className="editor-tool-row">
            <button type="button" aria-pressed={tool === "select"} onClick={() => { setTool("select"); setConnectionStart(null); }}>↖<small>선택</small></button>
            <button type="button" aria-pressed={tool === "connect"} onClick={() => { setTool("connect"); setConnectionStart(null); }}>⌁<small>통로</small></button>
          </div>
          <div className="editor-section-title"><span>02</span><strong>방 생성</strong></div>
          <div className="room-palette">
            {ROOM_TYPES.map((item) => <button key={item.type} type="button" aria-pressed={tool === "room" && placementType === item.type} onClick={() => { setPlacementType(item.type); setTool("room"); setConnectionStart(null); }}><i>{item.mark}</i><span>{item.label}</span></button>)}
          </div>
          <div className="editor-section-title"><span>03</span><strong>환경 에셋</strong></div>
          <div className="asset-palette">
            {THEMES.map((theme) => <button key={theme.id} type="button" disabled={!selected} aria-pressed={selected?.asset === theme.id} onClick={() => selected && updateRoom(selected.id, { asset: theme.id })} style={{ backgroundImage: `linear-gradient(90deg,rgba(5,7,6,.25),rgba(5,7,6,.92)),url(${theme.image})` }}><span>{theme.label}</span><small>ZONE {THEMES.indexOf(theme) + 1} ASSET</small></button>)}
          </div>
        </aside>

        <section className="editor-workspace" aria-label="맵 편집 캔버스">
          <div className="editor-ruler"><span>X 00</span><span>X 06</span><span>X 12</span><span>X 18</span><span>X 24</span></div>
          <svg viewBox="0 0 1300 700" onPointerDown={(event) => { if (event.target === event.currentTarget && tool === "room") { const point = pointInSvg(event); addRoom(point.x, point.y); } }} onPointerMove={(event) => {
            if (!dragRef.current) return;
            const point = pointInSvg(event);
            updateRoom(dragRef.current.id, { x: Math.max(0, Math.round((point.x - dragRef.current.offsetX) / CELL)), y: Math.max(0, Math.round((point.y - dragRef.current.offsetY) / CELL)) });
          }} onPointerUp={() => { dragRef.current = null; }} onPointerLeave={() => { dragRef.current = null; }}>
            <defs>
              <pattern id="editor-grid-small" width="50" height="50" patternUnits="userSpaceOnUse"><path d="M 50 0 L 0 0 0 50" fill="none" stroke="rgba(204,185,135,.12)" strokeWidth="1" /></pattern>
              <pattern id="editor-grid-large" width="250" height="250" patternUnits="userSpaceOnUse"><rect width="250" height="250" fill="url(#editor-grid-small)"/><path d="M 250 0 L 0 0 0 250" fill="none" stroke="rgba(204,185,135,.22)" strokeWidth="1.5" /></pattern>
              {THEMES.map((theme) => <pattern key={theme.id} id={`asset-${theme.id}`} width="180" height="140" patternUnits="userSpaceOnUse"><image href={theme.image} width="180" height="140" preserveAspectRatio="xMidYMid slice" opacity=".62" /></pattern>)}
              <filter id="room-shadow"><feDropShadow dx="0" dy="10" stdDeviation="10" floodOpacity=".55" /></filter>
            </defs>
            <rect width="1300" height="700" fill="url(#editor-grid-large)" pointerEvents="none" />
            {map.connections.map((connection) => {
              const from = map.rooms.find((room) => room.id === connection.from);
              const to = map.rooms.find((room) => room.id === connection.to);
              if (!from || !to) return null;
              const a = roomCenter(from); const b = roomCenter(to);
              return <g key={connection.id} className="editor-corridor"><path d={`M ${a.x} ${a.y} L ${b.x} ${b.y}`} /><path d={`M ${a.x} ${a.y} L ${b.x} ${b.y}`} /></g>;
            })}
            {map.rooms.map((room) => {
              const info = ROOM_TYPES.find((item) => item.type === room.type)!;
              const isSelected = selectedId === room.id;
              const isConnectionStart = connectionStart === room.id;
              return <g key={room.id} className={`editor-room ${isSelected ? "selected" : ""} ${isConnectionStart ? "connecting" : ""}`} transform={`translate(${room.x * CELL} ${room.y * CELL})`} onPointerDown={(event) => {
                event.stopPropagation();
                setSelectedId(room.id);
                if (tool === "connect") return connectRoom(room.id);
                if (tool !== "select") return;
                const svg = event.currentTarget.ownerSVGElement;
                if (!svg) return;
                svg.setPointerCapture(event.pointerId);
                const rect = svg.getBoundingClientRect();
                const x = (event.clientX - rect.left) * 1300 / rect.width;
                const y = (event.clientY - rect.top) * 700 / rect.height;
                dragRef.current = { id: room.id, offsetX: x - room.x * CELL, offsetY: y - room.y * CELL };
              }}>
                <rect className="room-shadow" width={room.width * CELL} height={room.height * CELL} rx="10" filter="url(#room-shadow)" />
                <rect className="room-surface" width={room.width * CELL} height={room.height * CELL} rx="8" fill={`url(#asset-${room.asset})`} />
                <rect className="room-frame" x="5" y="5" width={room.width * CELL - 10} height={room.height * CELL - 10} rx="5" />
                <text className="room-mark" x="18" y="28">{info.mark}</text>
                <text className="room-name" x="18" y="52">{room.name}</text>
                <text className="room-meta" x="18" y={room.height * CELL - 17}>{room.width}×{room.height} · {THEMES.find((theme) => theme.id === room.asset)?.label}</text>
                {isSelected ? <><path className="selected-corner" d={`M 0 20 V 0 H 20 M ${room.width * CELL - 20} 0 H ${room.width * CELL} V 20 M ${room.width * CELL} ${room.height * CELL - 20} V ${room.height * CELL} H ${room.width * CELL - 20} M 20 ${room.height * CELL} H 0 V ${room.height * CELL - 20}`} /></> : null}
              </g>;
            })}
          </svg>
          <div className="editor-mode-hint">{tool === "room" ? "캔버스를 클릭해 방을 배치하세요" : tool === "connect" ? connectionStart ? "연결할 두 번째 방을 선택하세요" : "통로의 시작 방을 선택하세요" : "방을 드래그해 이동하세요"}</div>
        </section>

        <aside className="editor-inspector" aria-label="선택 항목 속성">
          <div className="editor-section-title"><span>INSPECT</span><strong>방 속성</strong></div>
          {selected ? <>
            <label>이름<input value={selected.name} maxLength={24} onChange={(event) => updateRoom(selected.id, { name: event.target.value })} /></label>
            <label>방 종류<select value={selected.type} onChange={(event) => updateRoom(selected.id, { type: event.target.value as EditorRoomType })}>{ROOM_TYPES.map((item) => <option key={item.type} value={item.type}>{item.label}</option>)}</select></label>
            <div className="inspector-size"><label>가로 <input type="number" min="2" max="6" value={selected.width} onChange={(event) => updateRoom(selected.id, { width: clampSize(event.target.value) })} /></label><label>세로 <input type="number" min="2" max="5" value={selected.height} onChange={(event) => updateRoom(selected.id, { height: clampSize(event.target.value, 5) })} /></label></div>
            <div className="size-presets"><button type="button" onClick={() => updateRoom(selected.id, { width: 2, height: 2 })}>S</button><button type="button" onClick={() => updateRoom(selected.id, { width: 3, height: 3 })}>M</button><button type="button" onClick={() => updateRoom(selected.id, { width: 5, height: 4 })}>L</button></div>
            <dl><div><dt>좌표</dt><dd>{selected.x}, {selected.y}</dd></div><div><dt>연결 통로</dt><dd>{map.connections.filter((path) => path.from === selected.id || path.to === selected.id).length}개</dd></div><div><dt>에셋</dt><dd>{selected.asset}</dd></div></dl>
            <button type="button" className="delete-room" onClick={() => {
              setMap((current) => ({ ...current, rooms: current.rooms.filter((room) => room.id !== selected.id), connections: current.connections.filter((path) => path.from !== selected.id && path.to !== selected.id) }));
              setSelectedId("");
            }}>선택한 방 삭제</button>
          </> : <p className="inspector-empty">캔버스에서 방을 선택하세요.</p>}
          <div className="editor-validation">
            <div className="editor-section-title"><span>CHECK</span><strong>플레이 검증</strong></div>
            {failures.length === 0 ? <p className="valid">✓ 시작점부터 보스룸까지 플레이할 수 있습니다.</p> : <ul>{failures.map((failure) => <li key={failure}>{failure}</li>)}</ul>}
          </div>
          <button type="button" className="reset-map" onClick={() => { setMap(cloneEditorMap(DEFAULT_EDITOR_MAP)); setSelectedId(DEFAULT_EDITOR_MAP.rooms[0]?.id ?? ""); }}>기본 맵으로 되돌리기</button>
        </aside>
      </div>
    </main>
  );
}

function clampSize(value: string, max = 6): number {
  return Math.max(2, Math.min(max, Number(value) || 2));
}
