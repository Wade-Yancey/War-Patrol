import { formatContactDesignation } from './contactBook.js';

/**
 * PPI / cone-scope Contact-N label placement with light collision avoidance.
 * Keeps BRG/RNG off the plot (table owns those); only Cn designations on-scope.
 */

export interface ScopeLabelRequest {
  /** Stable contact id. */
  id: string;
  labelN: number;
  /** Blip center in scope SVG coords. */
  x: number;
  y: number;
  blipR: number;
}

export interface ScopeLabelObstacle {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutScopeLabelsOptions {
  cx: number;
  cy: number;
  scopeR: number;
  /** Soft keep-out boxes (e.g. sonar cone HDG tip). */
  obstacles?: ScopeLabelObstacle[];
  fontSizeLive?: number;
}

export interface ScopeLabelPlacement {
  id: string;
  labelN: number;
  /** Display string — short Cn. */
  text: string;
  visible: boolean;
  labelX: number;
  labelY: number;
  textAnchor: 'start' | 'end';
  fontSize: number;
  /** Thin CRT leader when the label is nudged off the blip. */
  leader?: { x1: number; y1: number; x2: number; y2: number };
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const CHAR_W = 0.62;
const LIVE_PAD = 10;
const STAGGER_STEP = 16;
const MAX_STAGGER_STEPS = 8;
const RIM_INSET = 28;
const LEADER_MIN_DY = 10;

function textWidth(text: string, fontSize: number): number {
  return Math.max(1, text.length * fontSize * CHAR_W);
}

function labelText(labelN: number): string {
  return formatContactDesignation(labelN);
}

function boxFor(
  labelX: number,
  labelY: number,
  textAnchor: 'start' | 'end',
  text: string,
  fontSize: number,
): Box {
  const w = textWidth(text, fontSize);
  const h = fontSize + 4;
  const left = textAnchor === 'end' ? labelX - w : labelX;
  return {
    left,
    right: left + w,
    top: labelY - h * 0.75,
    bottom: labelY + h * 0.35,
  };
}

function boxesOverlap(a: Box, b: Box, pad = 3): boolean {
  return !(
    a.right + pad < b.left ||
    a.left - pad > b.right ||
    a.bottom + pad < b.top ||
    a.top - pad > b.bottom
  );
}

function obstacleBox(o: ScopeLabelObstacle): Box {
  return {
    left: o.x - o.w / 2,
    right: o.x + o.w / 2,
    top: o.y - o.h / 2,
    bottom: o.y + o.h / 2,
  };
}

function preferLeft(x: number, cx: number): boolean {
  // Prefer labeling toward center when the blip is on the outer half.
  return x >= cx;
}

function clampToDisk(
  labelX: number,
  labelY: number,
  textAnchor: 'start' | 'end',
  text: string,
  fontSize: number,
  cx: number,
  cy: number,
  scopeR: number,
): { x: number; y: number } {
  const box = boxFor(labelX, labelY, textAnchor, text, fontSize);
  const midX = (box.left + box.right) / 2;
  const midY = (box.top + box.bottom) / 2;
  const dx = midX - cx;
  const dy = midY - cy;
  const dist = Math.hypot(dx, dy);
  const maxR = scopeR - RIM_INSET;
  if (dist <= maxR || dist < 1e-6) return { x: labelX, y: labelY };
  const scale = maxR / dist;
  const nx = cx + dx * scale;
  const ny = cy + dy * scale;
  const shiftX = nx - midX;
  const shiftY = ny - midY;
  return { x: labelX + shiftX, y: labelY + shiftY };
}

function placeOne(
  req: ScopeLabelRequest,
  opts: Pick<LayoutScopeLabelsOptions, 'cx' | 'cy' | 'scopeR' | 'fontSizeLive'>,
  occupied: Box[],
): ScopeLabelPlacement {
  const fontSize = opts.fontSizeLive ?? 16;
  const text = labelText(req.labelN);
  const pad = LIVE_PAD;

  const tryPlace = (flipSide: boolean, staggerDown: boolean): ScopeLabelPlacement | null => {
    for (let step = 0; step <= (staggerDown ? MAX_STAGGER_STEPS : 0); step++) {
      const left = flipSide
        ? !preferLeft(req.x, opts.cx)
        : preferLeft(req.x, opts.cx);
      const baseX = left ? req.x - req.blipR - pad : req.x + req.blipR + pad;
      const baseY = req.y + 5 + (staggerDown ? step * STAGGER_STEP : 0);
      const textAnchor: 'start' | 'end' = left ? 'end' : 'start';
      const clamped = clampToDisk(
        baseX,
        baseY,
        textAnchor,
        text,
        fontSize,
        opts.cx,
        opts.cy,
        opts.scopeR,
      );
      const box = boxFor(clamped.x, clamped.y, textAnchor, text, fontSize);
      if (occupied.some((o) => boxesOverlap(box, o))) continue;

      const dy = Math.abs(clamped.y - req.y);
      const leader =
        dy >= LEADER_MIN_DY
          ? {
              x1: req.x,
              y1: req.y,
              x2: left ? clamped.x : clamped.x,
              y2: clamped.y - fontSize * 0.35,
            }
          : undefined;

      return {
        id: req.id,
        labelN: req.labelN,
        text,
        visible: true,
        labelX: clamped.x,
        labelY: clamped.y,
        textAnchor,
        fontSize,
        leader,
      };
    }
    return null;
  };

  return (
    tryPlace(false, false) ??
    tryPlace(true, false) ??
    tryPlace(false, true) ??
    tryPlace(true, true) ?? {
      id: req.id,
      labelN: req.labelN,
      text,
      visible: true,
      labelX: preferLeft(req.x, opts.cx)
        ? req.x - req.blipR - pad
        : req.x + req.blipR + pad,
      labelY: req.y + 5,
      textAnchor: preferLeft(req.x, opts.cx) ? 'end' : 'start',
      fontSize,
    }
  );
}

/**
 * Layout Contact-N labels for polar CRT scopes (live contacts only).
 */
export function layoutScopeContactLabels(
  requests: ScopeLabelRequest[],
  options: LayoutScopeLabelsOptions,
): ScopeLabelPlacement[] {
  const cx = options.cx;
  const cy = options.cy;
  const scopeR = options.scopeR;
  const fontSizeLive = options.fontSizeLive ?? 16;

  const liveReqs = [...requests];

  // Stable visual order: closer to top of scope first so stagger fans downward.
  liveReqs.sort((a, b) => a.y - b.y || a.x - b.x || a.labelN - b.labelN);

  const occupied: Box[] = (options.obstacles ?? []).map(obstacleBox);
  const out: ScopeLabelPlacement[] = [];

  const opts = { cx, cy, scopeR, fontSizeLive };

  for (const req of liveReqs) {
    const placed = placeOne(req, opts, occupied);
    if (placed.visible) {
      occupied.push(
        boxFor(placed.labelX, placed.labelY, placed.textAnchor, placed.text, placed.fontSize),
      );
    }
    out.push(placed);
  }

  return out;
}
