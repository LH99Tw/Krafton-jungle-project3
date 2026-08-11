const EDITOR_VIEW_WIDTH = 1_300;
const EDITOR_VIEW_HEIGHT = 700;
const EDITOR_MIN_ZOOM = 0.2;
const EDITOR_MAX_ZOOM = 2.5;

export type EditorViewport = { centerX: number; centerY: number; zoom: number };
export type EditorViewBox = { x: number; y: number; width: number; height: number };

function clampEditorZoom(zoom: number): number {
  return Math.max(EDITOR_MIN_ZOOM, Math.min(EDITOR_MAX_ZOOM, zoom));
}

export function editorViewBox(
  viewport: EditorViewport,
  viewWidth = EDITOR_VIEW_WIDTH,
  viewHeight = EDITOR_VIEW_HEIGHT,
): EditorViewBox {
  const width = viewWidth / viewport.zoom;
  const height = viewHeight / viewport.zoom;
  return { x: viewport.centerX - width / 2, y: viewport.centerY - height / 2, width, height };
}

/** Keeps `worldPoint` fixed under the cursor while the zoom changes. */
export function zoomEditorViewportAt(
  viewport: EditorViewport,
  worldPoint: Readonly<{ x: number; y: number }>,
  requestedZoom: number,
): EditorViewport {
  const zoom = clampEditorZoom(requestedZoom);
  const scale = viewport.zoom / zoom;
  return {
    centerX: worldPoint.x - (worldPoint.x - viewport.centerX) * scale,
    centerY: worldPoint.y - (worldPoint.y - viewport.centerY) * scale,
    zoom,
  };
}

/** Converts a screen-space drag into the inverse world-space camera movement. */
export function panEditorViewport(viewport: EditorViewport, deltaScreenX: number, deltaScreenY: number): EditorViewport {
  return {
    ...viewport,
    centerX: viewport.centerX - deltaScreenX / viewport.zoom,
    centerY: viewport.centerY - deltaScreenY / viewport.zoom,
  };
}

export function fitEditorViewport(
  bounds: Readonly<{ x: number; y: number; width: number; height: number }>,
  padding = 100,
  viewWidth = EDITOR_VIEW_WIDTH,
  viewHeight = EDITOR_VIEW_HEIGHT,
): EditorViewport {
  const width = Math.max(1, bounds.width + padding * 2);
  const height = Math.max(1, bounds.height + padding * 2);
  return {
    centerX: bounds.x + bounds.width / 2,
    centerY: bounds.y + bounds.height / 2,
    zoom: clampEditorZoom(Math.min(viewWidth / width, viewHeight / height)),
  };
}

