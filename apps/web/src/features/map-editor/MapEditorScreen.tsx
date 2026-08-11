"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { OFFICIAL_MAP_COMPILER_VERSION, officialMapRevisionPayload } from "@five-days/game-core";
import {
  clampEditorPort,
  cloneEditorMap,
  DEFAULT_EDITOR_MAP,
  EDITOR_MAP_STORAGE_KEY,
  EDITOR_MAX_COORDINATE,
  EDITOR_MIN_COORDINATE,
  validateEditorMap,
  type EditorAssetTheme,
  type EditorConnection,
  type EditorConnectionPort,
  type EditorMapDefinition,
  type EditorRoom,
  type EditorRoomType,
} from "@/src/game/domain/mapEditor";
import { buildEditorGeometry, editorRoomPorts } from "@/src/game/domain/editorGeometry";
import {
  createStoredEditorMap,
  deleteStoredEditorMap,
  EDITOR_MAP_LIBRARY_STORAGE_KEY,
  parseEditorMapLibrary,
  upsertStoredEditorMap,
  type StoredEditorMap,
} from "@/src/game/domain/localMapLibrary";
import { buildEditorCoreWorld } from "./editorCoreWorld";
import {
  editorViewBox,
  fitEditorViewport,
  panEditorViewport,
  zoomEditorViewportAt,
  type EditorViewport,
} from "@/src/game/domain/editorViewport";

const CELL = 50;
const ROOM_TYPES: Array<{ type: EditorRoomType; label: string; mark: string }> = [
  { type: "empty", label: "일반 방", mark: "◇" },
  { type: "resource", label: "자원 방", mark: "◆" },
  { type: "static-monster", label: "몬스터 방", mark: "⚔" },
  { type: "hidden-monster", label: "숨겨진 몬스터 방", mark: "✦" },
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
type PortSelection = { roomId: string; port: EditorConnectionPort };
type PortEdit = { connectionId: string; endpoint: "from" | "to" };
type RoomDrag = { id: string; offsetX: number; offsetY: number };
type CameraDrag = { pointerId: number; clientX: number; clientY: number };

type InitialEditorState = {
  map: EditorMapDefinition;
  activeMapId: string;
  savedMaps: StoredEditorMap[];
};

function loadInitialEditorState(): InitialEditorState {
  const fallbackId = "local-map-default";
  const fallbackMap = cloneEditorMap(DEFAULT_EDITOR_MAP);
  if (typeof window === "undefined") {
    return { map: fallbackMap, activeMapId: fallbackId, savedMaps: [createStoredEditorMap(fallbackId, fallbackMap, 0)] };
  }
  const library = parseEditorMapLibrary(window.localStorage.getItem(EDITOR_MAP_LIBRARY_STORAGE_KEY));
  if (library) {
    const active = library.maps.find((record) => record.id === library.activeMapId) ?? library.maps[0]!;
    return { map: cloneEditorMap(active.map), activeMapId: active.id, savedMaps: library.maps };
  }
  try {
    const stored = window.localStorage.getItem(EDITOR_MAP_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as EditorMapDefinition;
      if (parsed.version === 1 && Array.isArray(parsed.rooms) && Array.isArray(parsed.connections)) {
        const migrated = createStoredEditorMap(fallbackId, parsed);
        return { map: cloneEditorMap(parsed), activeMapId: fallbackId, savedMaps: [migrated] };
      }
    }
  } catch {
    // Corrupt local drafts fall back to the bundled starter map.
  }
  return { map: fallbackMap, activeMapId: fallbackId, savedMaps: [createStoredEditorMap(fallbackId, fallbackMap)] };
}

export function MapEditorScreen({ onBack, onPlay }: { onBack: () => void; onPlay: (map: EditorMapDefinition) => void }) {
  const [initialState] = useState(loadInitialEditorState);
  const [map, setMap] = useState(initialState.map);
  const [activeMapId, setActiveMapId] = useState(initialState.activeMapId);
  const [savedMaps, setSavedMaps] = useState(initialState.savedMaps);
  const [tool, setTool] = useState<Tool>("select");
  const [placementType, setPlacementType] = useState<EditorRoomType>("empty");
  const [selectedId, setSelectedId] = useState<string>(() => map.rooms[0]?.id ?? "");
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [connectionStart, setConnectionStart] = useState<PortSelection | null>(null);
  const [hoveredPort, setHoveredPort] = useState<PortSelection | null>(null);
  const [portEdit, setPortEdit] = useState<PortEdit | null>(null);
  const [routeError, setRouteError] = useState("");
  const [spacePressed, setSpacePressed] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ width: 1_300, height: 700 });
  const [viewport, setViewport] = useState<EditorViewport>(() => focusStartViewport(map));
  const workspaceRef = useRef<HTMLElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const roomDragRef = useRef<RoomDrag | null>(null);
  const cameraDragRef = useRef<CameraDrag | null>(null);
  const spacePressedRef = useRef(false);

  const failures = useMemo(() => validateEditorMap(map), [map]);
  const isDirty = useMemo(() => {
    const saved = savedMaps.find((record) => record.id === activeMapId);
    return !saved || JSON.stringify(saved.map) !== JSON.stringify(map);
  }, [activeMapId, map, savedMaps]);
  const selected = map.rooms.find((room) => room.id === selectedId) ?? null;
  const selectedConnection = map.connections.find((connection) => connection.id === selectedConnectionId) ?? null;
  const geometry = useMemo(() => buildEditorGeometry(map, editorScale()), [map]);
  const selectedRoute = geometry.routes.find((route) => route.connectionId === selectedConnectionId) ?? null;
  const viewBox = editorViewBox(viewport, canvasSize.width, canvasSize.height);
  const previewRoute = useMemo(() => {
    if (!connectionStart || !hoveredPort || connectionStart.roomId === hoveredPort.roomId) return null;
    if (map.connections.some((connection) => sameConnection(connection, connectionStart.roomId, hoveredPort.roomId))) return null;
    const preview: EditorConnection = {
      id: "zzzz-preview",
      from: connectionStart.roomId,
      to: hoveredPort.roomId,
      fromPort: connectionStart.port,
      toPort: hoveredPort.port,
    };
    return buildEditorGeometry({ ...map, connections: [...map.connections, preview] }, editorScale())
      .routes.find((route) => route.connectionId === preview.id) ?? null;
  }, [connectionStart, hoveredPort, map]);
  const previewInvalid = Boolean(connectionStart && hoveredPort && connectionStart.roomId !== hoveredPort.roomId && !previewRoute);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSavedMaps((current) => {
        const updated = upsertStoredEditorMap(current, activeMapId, map);
        persistMapLibrary(updated, activeMapId, map);
        return updated;
      });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [activeMapId, map]);

  useEffect(() => {
    const element = workspaceRef.current;
    if (!element) return;
    const update = () => setCanvasSize({ width: Math.max(320, element.clientWidth), height: Math.max(320, element.clientHeight) });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || isTextInput(event.target)) return;
      event.preventDefault();
      spacePressedRef.current = true;
      setSpacePressed(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      spacePressedRef.current = false;
      setSpacePressed(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  const updateRoom = (id: string, patch: Partial<EditorRoom>) => {
    setMap((current) => {
      const rooms = current.rooms.map((room) => room.id === id ? normalizeRoom({ ...room, ...patch }) : room);
      const changed = rooms.find((room) => room.id === id);
      const connections = current.connections.map((connection) => {
        if (!changed) return connection;
        if (connection.from === id && connection.fromPort) return { ...connection, fromPort: clampEditorPort(changed, connection.fromPort) };
        if (connection.to === id && connection.toPort) return { ...connection, toPort: clampEditorPort(changed, connection.toPort) };
        return connection;
      });
      return { ...current, rooms, connections };
    });
  };

  const addRoom = (x: number, y: number) => {
    const id = nextAvailableId("room-local", map.rooms.map((room) => room.id));
    const typeInfo = ROOM_TYPES.find((candidate) => candidate.type === placementType);
    const room = normalizeRoom({
      id,
      name: typeInfo?.label ?? "새 방",
      type: placementType,
      asset: "forest",
      x: Math.round(x / CELL),
      y: Math.round(y / CELL),
      width: placementType === "boss" ? 4 : 3,
      height: placementType === "boss" ? 4 : 3,
    });
    setMap((current) => ({ ...current, rooms: [...current.rooms, room] }));
    setSelectedId(id);
    setSelectedConnectionId(null);
    setTool("select");
  };

  const choosePort = (roomId: string, port: EditorConnectionPort) => {
    setRouteError("");
    if (portEdit) {
      const connection = map.connections.find((candidate) => candidate.id === portEdit.connectionId);
      const expectedRoom = connection?.[portEdit.endpoint];
      if (!connection || expectedRoom !== roomId) return;
      const replacement = {
        ...connection,
        [portEdit.endpoint === "from" ? "fromPort" : "toPort"]: port,
      };
      const candidate = { ...map, connections: map.connections.map((item) => item.id === replacement.id ? replacement : item) };
      const valid = buildEditorGeometry(candidate, editorScale()).routes.some((route) => route.connectionId === replacement.id);
      if (!valid) return setRouteError("선택한 출입구에서는 다른 구조물을 피하는 통로를 만들 수 없습니다.");
      setMap(candidate);
      setPortEdit(null);
      return;
    }
    if (tool !== "connect") return;
    if (!connectionStart) {
      setConnectionStart({ roomId, port });
      setSelectedConnectionId(null);
      setSelectedId(roomId);
      return;
    }
    if (connectionStart.roomId === roomId) return;
    if (map.connections.some((connection) => sameConnection(connection, connectionStart.roomId, roomId))) {
      setRouteError("두 방 사이에는 하나의 통로만 만들 수 있습니다.");
      return;
    }
    const connection: EditorConnection = {
      id: nextAvailableId("path-local", map.connections.map((candidate) => candidate.id)),
      from: connectionStart.roomId,
      to: roomId,
      fromPort: connectionStart.port,
      toPort: port,
    };
    const candidate = { ...map, connections: [...map.connections, connection] };
    if (!buildEditorGeometry(candidate, editorScale()).routes.some((route) => route.connectionId === connection.id)) {
      setRouteError("선택한 두 출입구 사이에 유효한 자동 경로가 없습니다.");
      return;
    }
    setMap(candidate);
    setSelectedConnectionId(connection.id);
    setSelectedId("");
    setConnectionStart(null);
    setHoveredPort(null);
    setTool("select");
  };

  const selectConnection = (connectionId: string) => {
    setSelectedConnectionId(connectionId);
    setSelectedId("");
    setTool("select");
    setConnectionStart(null);
    setPortEdit(null);
    setRouteError("");
  };

  const pointInSvg = (event: Readonly<{ clientX: number; clientY: number }>) => {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM();
    if (svg && matrix) {
      const point = svg.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      return point.matrixTransform(matrix.inverse());
    }
    return { x: viewport.centerX, y: viewport.centerY };
  };

  const focusStart = () => setViewport(focusStartViewport(map));
  const fitAll = () => setViewport(fitEditorViewport(geometryBounds(geometry.floorRects), 100, canvasSize.width, canvasSize.height));
  const zoomBy = (factor: number) => setViewport((current) => zoomEditorViewportAt(
    current,
    { x: current.centerX, y: current.centerY },
    current.zoom * factor,
  ));

  const exportOfficialMap = async () => {
    const validationFailures = validateEditorMap(map);
    if (validationFailures.length > 0) {
      setRouteError(validationFailures.join(" "));
      return;
    }
    const normalizedMap = cloneEditorMap(map);
    const world = { ...buildEditorCoreWorld(normalizedMap), id: "official-map" };
    const bytes = new TextEncoder().encode(JSON.stringify(officialMapRevisionPayload(normalizedMap, world)));
    const digest = await window.crypto.subtle.digest("SHA-256", bytes);
    const mapRevision = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
    const manifest = {
      schemaVersion: 1 as const,
      compilerVersion: OFFICIAL_MAP_COMPILER_VERSION,
      mapRevision,
      map: normalizedMap,
      world,
    };
    const blob = new Blob([`${JSON.stringify(manifest, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "official-map.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const resetEditorSelection = (nextMap: EditorMapDefinition) => {
    setSelectedId(nextMap.rooms[0]?.id ?? "");
    setSelectedConnectionId(null);
    setConnectionStart(null);
    setHoveredPort(null);
    setPortEdit(null);
    setRouteError("");
    setTool("select");
    setViewport(focusStartViewport(nextMap));
  };

  const saveCurrentMap = () => {
    const updated = upsertStoredEditorMap(savedMaps, activeMapId, map);
    setSavedMaps(updated);
    persistMapLibrary(updated, activeMapId, map);
  };

  const openSavedMap = (id: string) => {
    if (id === activeMapId) return;
    const withCurrentSaved = upsertStoredEditorMap(savedMaps, activeMapId, map);
    const target = withCurrentSaved.find((record) => record.id === id);
    if (!target) return;
    const nextMap = cloneEditorMap(target.map);
    setSavedMaps(withCurrentSaved);
    setActiveMapId(id);
    setMap(nextMap);
    persistMapLibrary(withCurrentSaved, id, nextMap);
    resetEditorSelection(nextMap);
  };

  const createNewMap = () => {
    const withCurrentSaved = upsertStoredEditorMap(savedMaps, activeMapId, map);
    const nextMap = cloneEditorMap(DEFAULT_EDITOR_MAP);
    nextMap.title = nextUntitledMapName(withCurrentSaved);
    const id = createLocalMapId();
    const updated = [createStoredEditorMap(id, nextMap), ...withCurrentSaved];
    setSavedMaps(updated);
    setActiveMapId(id);
    setMap(nextMap);
    persistMapLibrary(updated, id, nextMap);
    resetEditorSelection(nextMap);
  };

  const removeSavedMap = (id: string) => {
    const target = savedMaps.find((record) => record.id === id);
    if (!target || !window.confirm(`“${target.map.title}” 맵을 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return;
    const withCurrentSaved = upsertStoredEditorMap(savedMaps, activeMapId, map);
    let updated = deleteStoredEditorMap(withCurrentSaved, id);
    if (id !== activeMapId) {
      setSavedMaps(updated);
      persistMapLibrary(updated, activeMapId, map);
      return;
    }
    if (updated.length === 0) {
      const nextMap = cloneEditorMap(DEFAULT_EDITOR_MAP);
      nextMap.title = "새 로컬 맵";
      const nextId = createLocalMapId();
      updated = [createStoredEditorMap(nextId, nextMap)];
    }
    const next = updated[0]!;
    const nextMap = cloneEditorMap(next.map);
    setSavedMaps(updated);
    setActiveMapId(next.id);
    setMap(nextMap);
    persistMapLibrary(updated, next.id, nextMap);
    resetEditorSelection(nextMap);
  };

  return (
    <main className="map-editor-screen">
      <header className="map-editor-header">
        <button type="button" className="editor-back" onClick={onBack}>← 원정대 화면</button>
        <div>
          <span>LOCAL WORLD FORGE</span>
          <input aria-label="맵 이름" value={map.title} maxLength={40} onChange={(event) => setMap({ ...map, title: event.target.value })} />
        </div>
        <div className={`editor-save-state ${isDirty ? "saving" : "saved"}`}><i /> {isDirty ? "변경사항 저장 중" : "브라우저에 저장됨"}</div>
        <button type="button" className="editor-play editor-export" disabled={failures.length > 0} onClick={() => void exportOfficialMap()}>공식 맵 JSON 내보내기</button>
        <button type="button" className="editor-play" disabled={failures.length > 0} onClick={() => onPlay(cloneEditorMap(map))}>임시 적용 · 플레이 <b>▶</b></button>
      </header>

      <section className="map-library-bar" aria-label="저장된 맵 관리">
        <div className="map-library-heading">
          <span>LOCAL ARCHIVE</span>
          <strong>저장된 맵</strong>
        </div>
        <div className="map-library-actions">
          <button type="button" onClick={createNewMap}>＋ 새 맵</button>
          <button type="button" onClick={saveCurrentMap}>저장</button>
        </div>
        <div className="map-library-list" role="list" aria-label="저장된 로컬 맵">
          {savedMaps.map((record) => {
            const isActive = record.id === activeMapId;
            const displayedMap = isActive ? map : record.map;
            return <div key={record.id} className={isActive ? "active" : ""} role="listitem">
              <button type="button" className="map-library-open" aria-current={isActive ? "page" : undefined} onClick={() => openSavedMap(record.id)}>
                <strong>{displayedMap.title || "이름 없는 맵"}</strong>
                <span>{displayedMap.rooms.length} ROOMS · {formatSavedTime(record.updatedAt)}</span>
              </button>
              <button type="button" className="map-library-delete" aria-label={`${displayedMap.title || "이름 없는 맵"} 삭제`} onClick={() => removeSavedMap(record.id)}>×</button>
            </div>;
          })}
        </div>
        <span className="map-library-count">{savedMaps.length.toString().padStart(2, "0")} MAPS</span>
      </section>

      <div className="map-editor-layout">
        <aside className="editor-tools" aria-label="맵 제작 도구">
          <div className="editor-section-title"><span>01</span><strong>제작 도구</strong></div>
          <div className="editor-tool-row">
            <button type="button" aria-pressed={tool === "select"} onClick={() => { setTool("select"); setConnectionStart(null); setPortEdit(null); }}>↖<small>선택</small></button>
            <button type="button" aria-pressed={tool === "connect"} onClick={() => { setTool("connect"); setConnectionStart(null); setPortEdit(null); setRouteError(""); }}>⌁<small>통로</small></button>
          </div>
          <div className="editor-section-title"><span>02</span><strong>방 생성</strong></div>
          <div className="room-palette">
            {ROOM_TYPES.map((item) => <button key={item.type} type="button" aria-pressed={tool === "room" && placementType === item.type} onClick={() => { setPlacementType(item.type); setTool("room"); setConnectionStart(null); setPortEdit(null); }}><i>{item.mark}</i><span>{item.label}</span></button>)}
          </div>
          <div className="editor-section-title"><span>03</span><strong>환경 에셋</strong></div>
          <div className="asset-palette">
            {THEMES.map((theme) => <button key={theme.id} type="button" disabled={!selected} aria-pressed={selected?.asset === theme.id} onClick={() => selected && updateRoom(selected.id, { asset: theme.id })} style={{ backgroundImage: `linear-gradient(90deg,rgba(5,7,6,.25),rgba(5,7,6,.92)),url(${theme.image})` }}><span>{theme.label}</span><small>ZONE {THEMES.indexOf(theme) + 1} ASSET</small></button>)}
          </div>
        </aside>

        <section ref={workspaceRef} className={`editor-workspace ${spacePressed || isPanning ? "panning" : ""}`} aria-label="맵 편집 캔버스">
          <div className="editor-ruler"><span>X {Math.floor(viewBox.x / CELL)}</span><span>Y {Math.floor(viewBox.y / CELL)}</span><span>{Math.round(viewport.zoom * 100)}%</span></div>
          <div className="editor-viewport-controls" aria-label="캔버스 보기 조절">
            <button type="button" aria-label="축소" onClick={() => zoomBy(0.8)}>−</button>
            <button type="button" aria-label="확대" onClick={() => zoomBy(1.25)}>＋</button>
            <button type="button" onClick={focusStart}>⌂ 시작점</button>
            <button type="button" onClick={fitAll}>전체 맞춤</button>
          </div>
          <svg
            ref={svgRef}
            viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
            onContextMenu={(event) => event.preventDefault()}
            onWheel={(event) => {
              event.preventDefault();
              const worldPoint = pointInSvg(event);
              const factor = Math.exp(-event.deltaY * 0.0015);
              setViewport((current) => zoomEditorViewportAt(current, worldPoint, current.zoom * factor));
            }}
            onPointerDown={(event) => {
              const wantsPan = event.button === 1 || (event.button === 0 && spacePressedRef.current);
              if (wantsPan) {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                cameraDragRef.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY };
                setIsPanning(true);
                return;
              }
              if (event.target === event.currentTarget && tool === "room" && event.button === 0) {
                const point = pointInSvg(event);
                addRoom(point.x, point.y);
              } else if (event.target === event.currentTarget && event.button === 0) {
                setSelectedId("");
                setSelectedConnectionId(null);
              }
            }}
            onPointerMove={(event) => {
              const cameraDrag = cameraDragRef.current;
              if (cameraDrag?.pointerId === event.pointerId) {
                const deltaX = event.clientX - cameraDrag.clientX;
                const deltaY = event.clientY - cameraDrag.clientY;
                cameraDrag.clientX = event.clientX;
                cameraDrag.clientY = event.clientY;
                setViewport((current) => panEditorViewport(current, deltaX, deltaY));
                return;
              }
              const roomDrag = roomDragRef.current;
              if (!roomDrag) return;
              const point = pointInSvg(event);
              updateRoom(roomDrag.id, { x: Math.round((point.x - roomDrag.offsetX) / CELL), y: Math.round((point.y - roomDrag.offsetY) / CELL) });
            }}
            onPointerUp={(event) => {
              if (cameraDragRef.current?.pointerId === event.pointerId) {
                cameraDragRef.current = null;
                setIsPanning(false);
              }
              roomDragRef.current = null;
            }}
            onPointerCancel={() => { cameraDragRef.current = null; roomDragRef.current = null; setIsPanning(false); }}
          >
            <defs>
              <pattern id="editor-grid-small" width={CELL} height={CELL} patternUnits="userSpaceOnUse"><path d={`M ${CELL} 0 L 0 0 0 ${CELL}`} fill="none" stroke="rgba(204,185,135,.12)" strokeWidth={1 / viewport.zoom} /></pattern>
              <pattern id="editor-grid-large" width={CELL * 5} height={CELL * 5} patternUnits="userSpaceOnUse"><rect width={CELL * 5} height={CELL * 5} fill="url(#editor-grid-small)"/><path d={`M ${CELL * 5} 0 L 0 0 0 ${CELL * 5}`} fill="none" stroke="rgba(204,185,135,.22)" strokeWidth={1.5 / viewport.zoom} /></pattern>
              {THEMES.map((theme) => <pattern key={theme.id} id={`asset-${theme.id}`} width="180" height="140" patternUnits="userSpaceOnUse"><image href={theme.image} width="180" height="140" preserveAspectRatio="xMidYMid slice" opacity=".62" /></pattern>)}
              <filter id="room-shadow"><feDropShadow dx="0" dy="10" stdDeviation="10" floodOpacity=".55" /></filter>
            </defs>
            <rect x={EDITOR_MIN_COORDINATE * CELL} y={EDITOR_MIN_COORDINATE * CELL} width={(EDITOR_MAX_COORDINATE - EDITOR_MIN_COORDINATE + 1) * CELL} height={(EDITOR_MAX_COORDINATE - EDITOR_MIN_COORDINATE + 1) * CELL} fill="url(#editor-grid-large)" pointerEvents="none" />
            {geometry.routes.map((route) => {
              const path = polylinePath(route.points);
              const connection = map.connections.find((candidate) => candidate.id === route.connectionId);
              const fromName = map.rooms.find((room) => room.id === connection?.from)?.name ?? "방";
              const toName = map.rooms.find((room) => room.id === connection?.to)?.name ?? "방";
              return <g key={route.connectionId} role="button" tabIndex={0} aria-label={`통로: ${fromName} ↔ ${toName}`} className={`editor-corridor ${selectedConnectionId === route.connectionId ? "selected" : ""}`} onClick={(event) => { event.stopPropagation(); selectConnection(route.connectionId); }} onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                selectConnection(route.connectionId);
              }}><path className="corridor-wall" d={path} /><path className="corridor-floor" d={path} /><path className="corridor-center" d={path} /><path className="corridor-hit" d={path} /></g>;
            })}
            {previewRoute && <g className="editor-corridor preview" pointerEvents="none"><path className="corridor-wall" d={polylinePath(previewRoute.points)} /><path className="corridor-floor" d={polylinePath(previewRoute.points)} /><path className="corridor-center" d={polylinePath(previewRoute.points)} /></g>}
            {map.rooms.map((room) => {
              const info = ROOM_TYPES.find((item) => item.type === room.type)!;
              const isSelected = selectedId === room.id;
              const isConnectionStart = connectionStart?.roomId === room.id;
              return <g key={room.id} className={`editor-room ${isSelected ? "selected" : ""} ${isConnectionStart ? "connecting" : ""}`} transform={`translate(${room.x * CELL} ${room.y * CELL})`} onPointerDown={(event) => {
                if (spacePressedRef.current || event.button === 1) return;
                event.stopPropagation();
                setSelectedId(room.id);
                setSelectedConnectionId(null);
                if (tool !== "select" || event.button !== 0) return;
                const point = pointInSvg(event);
                svgRef.current?.setPointerCapture(event.pointerId);
                roomDragRef.current = { id: room.id, offsetX: point.x - room.x * CELL, offsetY: point.y - room.y * CELL };
              }}>
                <rect className="room-shadow" width={room.width * CELL} height={room.height * CELL} rx="10" filter="url(#room-shadow)" />
                <rect className="room-surface" width={room.width * CELL} height={room.height * CELL} rx="8" fill={`url(#asset-${room.asset})`} />
                <rect className="room-frame" x="5" y="5" width={room.width * CELL - 10} height={room.height * CELL - 10} rx="5" />
                <text className="room-mark" x="18" y="28">{info.mark}</text>
                <text className="room-name" x="18" y="52">{room.name}</text>
                <text className="room-meta" x="18" y={room.height * CELL - 17}>{room.width}×{room.height} · {THEMES.find((theme) => theme.id === room.asset)?.label}</text>
                {isSelected ? <path className="selected-corner" d={`M 0 20 V 0 H 20 M ${room.width * CELL - 20} 0 H ${room.width * CELL} V 20 M ${room.width * CELL} ${room.height * CELL - 20} V ${room.height * CELL} H ${room.width * CELL - 20} M 20 ${room.height * CELL} H 0 V ${room.height * CELL - 20}`} /> : null}
              </g>;
            })}
            <g className="editor-auto-walls" pointerEvents="none">
              {geometry.wallSegments.map((wall, index) => <g key={`${wall.x1}:${wall.y1}:${index}`}><line className="wall-base" x1={wall.x1} y1={wall.y1} x2={wall.x2} y2={wall.y2} /><line className="wall-cap" x1={wall.x1} y1={wall.y1} x2={wall.x2} y2={wall.y2} /></g>)}
            </g>
            <g className="editor-port-layer">
              {map.rooms.flatMap((room) => shouldShowPorts(room, tool, connectionStart, portEdit, selectedConnection)
                ? editorRoomPorts(room).map((candidate) => {
                    const active = connectionStart?.roomId === room.id && samePort(connectionStart.port, candidate.port);
                    const hovered = hoveredPort?.roomId === room.id && samePort(hoveredPort.port, candidate.port);
                    return <circle
                      key={`${room.id}:${candidate.port.side}:${candidate.port.offset}`}
                      className={`editor-port ${active ? "active" : ""} ${hovered ? "hovered" : ""} ${hovered && previewInvalid ? "invalid" : ""}`}
                      cx={candidate.door.x * CELL}
                      cy={candidate.door.y * CELL}
                      r={8 / viewport.zoom}
                      strokeWidth={2 / viewport.zoom}
                      onPointerEnter={() => setHoveredPort({ roomId: room.id, port: candidate.port })}
                      onPointerLeave={() => setHoveredPort((current) => current?.roomId === room.id && samePort(current.port, candidate.port) ? null : current)}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        if (event.button === 0) choosePort(room.id, candidate.port);
                      }}
                    />;
                  }) : [])}
            </g>
          </svg>
          <div className={`editor-mode-hint ${routeError || previewInvalid ? "error" : ""}`}>{routeError || (previewInvalid ? "이 출입구 조합은 다른 방·통로를 관통합니다" : editorHint(tool, connectionStart, portEdit))}</div>
        </section>

        <aside className="editor-inspector" aria-label="선택 항목 속성">
          <div className="editor-section-title"><span>INSPECT</span><strong>{selectedConnection ? "통로 속성" : "방 속성"}</strong></div>
          {selectedConnection ? <>
            <div className="corridor-inspector-mark">⌁</div>
            <dl className="corridor-inspector-data">
              <div><dt>시작 방</dt><dd>{map.rooms.find((room) => room.id === selectedConnection.from)?.name ?? "-"}</dd></div>
              <div><dt>시작 출입구</dt><dd>{formatPort(selectedConnection.fromPort)}</dd></div>
              <div><dt>도착 방</dt><dd>{map.rooms.find((room) => room.id === selectedConnection.to)?.name ?? "-"}</dd></div>
              <div><dt>도착 출입구</dt><dd>{formatPort(selectedConnection.toPort)}</dd></div>
              <div><dt>직교 길이</dt><dd>{selectedRoute ? `${Math.round(selectedRoute.length)}px` : "경로 없음"}</dd></div>
              <div><dt>꺾임</dt><dd>{selectedRoute ? `${selectedRoute.bends}회` : "-"}</dd></div>
            </dl>
            <div className="corridor-port-actions">
              <button type="button" aria-pressed={portEdit?.endpoint === "from"} onClick={() => { setPortEdit({ connectionId: selectedConnection.id, endpoint: "from" }); setRouteError(""); }}>시작 위치 변경</button>
              <button type="button" aria-pressed={portEdit?.endpoint === "to"} onClick={() => { setPortEdit({ connectionId: selectedConnection.id, endpoint: "to" }); setRouteError(""); }}>도착 위치 변경</button>
            </div>
            <p className={selectedRoute ? "corridor-route-ok" : "corridor-route-error"}>{selectedRoute ? "✓ 지정 출입구 사이 자동 경로" : "× 다른 방이나 통로를 피할 경로가 없습니다."}</p>
            <button type="button" className="delete-room" onClick={() => {
              setMap((current) => ({ ...current, connections: current.connections.filter((connection) => connection.id !== selectedConnection.id) }));
              setSelectedConnectionId(null);
              setPortEdit(null);
            }}>선택한 통로 삭제</button>
          </> : selected ? <>
            <label>이름<input value={selected.name} maxLength={24} onChange={(event) => updateRoom(selected.id, { name: event.target.value })} /></label>
            <label>방 종류<select value={selected.type} onChange={(event) => updateRoom(selected.id, { type: event.target.value as EditorRoomType })}>{ROOM_TYPES.map((item) => <option key={item.type} value={item.type}>{item.label}</option>)}</select></label>
            <div className="inspector-size"><label>가로 <input type="number" min="2" max="6" value={selected.width} onChange={(event) => updateRoom(selected.id, { width: clampSize(event.target.value) })} /></label><label>세로 <input type="number" min="2" max="5" value={selected.height} onChange={(event) => updateRoom(selected.id, { height: clampSize(event.target.value, 5) })} /></label></div>
            <div className="size-presets"><button type="button" onClick={() => updateRoom(selected.id, { width: 2, height: 2 })}>S</button><button type="button" onClick={() => updateRoom(selected.id, { width: 3, height: 3 })}>M</button><button type="button" onClick={() => updateRoom(selected.id, { width: 5, height: 4 })}>L</button></div>
            <dl><div><dt>좌표</dt><dd>{selected.x}, {selected.y}</dd></div><div><dt>연결 통로</dt><dd>{map.connections.filter((path) => path.from === selected.id || path.to === selected.id).length}개</dd></div><div><dt>에셋</dt><dd>{selected.asset}</dd></div></dl>
            <button type="button" className="delete-room" onClick={() => {
              setMap((current) => ({ ...current, rooms: current.rooms.filter((room) => room.id !== selected.id), connections: current.connections.filter((path) => path.from !== selected.id && path.to !== selected.id) }));
              setSelectedId("");
            }}>선택한 방 삭제</button>
          </> : <p className="inspector-empty">캔버스에서 방이나 통로를 선택하세요.</p>}
          <div className="editor-validation">
            <div className="editor-section-title"><span>CHECK</span><strong>플레이 검증</strong></div>
            {failures.length === 0 ? <p className="valid">✓ 시작점부터 보스룸까지 플레이할 수 있습니다.</p> : <ul>{failures.map((failure) => <li key={failure}>{failure}</li>)}</ul>}
          </div>
          <button type="button" className="reset-map" onClick={() => { const reset = cloneEditorMap(DEFAULT_EDITOR_MAP); setMap(reset); setSelectedId(reset.rooms[0]?.id ?? ""); setViewport(focusStartViewport(reset)); }}>기본 맵으로 되돌리기</button>
        </aside>
      </div>
    </main>
  );
}

function editorScale() { return { cellWidth: CELL, cellHeight: CELL, corridorWidth: 24 }; }

function clampSize(value: string, max = 6): number {
  return Math.max(2, Math.min(max, Number(value) || 2));
}

function normalizeRoom(room: EditorRoom): EditorRoom {
  const width = Math.max(2, Math.min(6, Math.round(room.width)));
  const height = Math.max(2, Math.min(5, Math.round(room.height)));
  return {
    ...room,
    width,
    height,
    x: Math.max(EDITOR_MIN_COORDINATE, Math.min(EDITOR_MAX_COORDINATE - width + 1, Math.round(room.x))),
    y: Math.max(EDITOR_MIN_COORDINATE, Math.min(EDITOR_MAX_COORDINATE - height + 1, Math.round(room.y))),
  };
}

function focusStartViewport(map: EditorMapDefinition): EditorViewport {
  const start = map.rooms.find((room) => room.type === "start") ?? map.rooms[0];
  return start
    ? { centerX: (start.x + start.width / 2) * CELL, centerY: (start.y + start.height / 2) * CELL, zoom: 1 }
    : { centerX: 0, centerY: 0, zoom: 1 };
}

function geometryBounds(rects: readonly { x: number; y: number; width: number; height: number }[]) {
  if (rects.length === 0) return { x: -CELL, y: -CELL, width: CELL * 2, height: CELL * 2 };
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x, y, width: right - x, height: bottom - y };
}

function shouldShowPorts(
  room: EditorRoom,
  tool: Tool,
  connectionStart: PortSelection | null,
  portEdit: PortEdit | null,
  selectedConnection: EditorConnection | null,
): boolean {
  if (portEdit && selectedConnection) return selectedConnection[portEdit.endpoint] === room.id;
  if (tool !== "connect") return false;
  return true;
}

function sameConnection(connection: EditorConnection, left: string, right: string): boolean {
  return (connection.from === left && connection.to === right) || (connection.from === right && connection.to === left);
}

function samePort(left: EditorConnectionPort, right: EditorConnectionPort): boolean {
  return left.side === right.side && left.offset === right.offset;
}

function formatPort(port?: EditorConnectionPort): string {
  if (!port) return "자동";
  const label = { north: "위", east: "오른쪽", south: "아래", west: "왼쪽" }[port.side];
  return `${label} ${port.offset + 1}`;
}

function editorHint(tool: Tool, connectionStart: PortSelection | null, portEdit: PortEdit | null): string {
  if (portEdit) return `${portEdit.endpoint === "from" ? "시작" : "도착"} 방의 새 출입구를 선택하세요`;
  if (tool === "room") return "현재 화면의 빈 격자를 클릭해 방을 배치하세요";
  if (tool === "connect") return connectionStart ? "도착 방의 출입구를 선택하세요" : "시작 방 테두리의 출입구를 선택하세요";
  return "방 드래그 · 휠 확대/축소 · Space+드래그 이동";
}

function isTextInput(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

function polylinePath(points: readonly { x: number; y: number }[]): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}

function nextAvailableId(prefix: string, ids: readonly string[]): string {
  const used = new Set(ids);
  let sequence = used.size + 1;
  while (used.has(`${prefix}-${sequence}`)) sequence += 1;
  return `${prefix}-${sequence}`;
}

function createLocalMapId(): string {
  return typeof window !== "undefined" && typeof window.crypto?.randomUUID === "function"
    ? `local-map-${window.crypto.randomUUID()}`
    : `local-map-${Date.now().toString(36)}`;
}

function nextUntitledMapName(maps: readonly StoredEditorMap[]): string {
  const titles = new Set(maps.map((record) => record.map.title));
  let sequence = maps.length + 1;
  while (titles.has(`새 로컬 맵 ${sequence}`)) sequence += 1;
  return `새 로컬 맵 ${sequence}`;
}

function formatSavedTime(timestamp: number): string {
  if (timestamp <= 0) return "LOCAL";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function persistMapLibrary(
  maps: readonly StoredEditorMap[],
  activeMapId: string,
  activeMap: EditorMapDefinition,
): void {
  window.localStorage.setItem(EDITOR_MAP_LIBRARY_STORAGE_KEY, JSON.stringify({
    version: 1,
    activeMapId,
    maps,
  }));
  // Keep the previous single-draft key in sync for backwards compatibility.
  window.localStorage.setItem(EDITOR_MAP_STORAGE_KEY, JSON.stringify(activeMap));
}
