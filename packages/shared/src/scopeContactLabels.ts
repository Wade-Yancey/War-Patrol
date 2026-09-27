import { formatContactDesignation } from './contactBook.js';

/**
 * PPI / cone-scope Contact-N label placement with light collision avoidance.
 * Keeps BRG/RNG off the plot (table owns those); only Cn designations on-scope.
 */

export type ScopeLabelKind = 'live' | 'ghost';

export interface ScopeLabelRequest {
  /** Stable contact id (same id may appear as both live + ghost). */
  id: string;
  labelN: number;
  /** Blip center in scope SVG coords. */
  x: number;
  y: number;
  blipR: number;
  kind: ScopeLabelKind;
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
  fontSizeGhost?: number;
  /** Hide ghost Contact N when ghost blip is within this px of the live blip (same id). */
  ghostSuppressNearLivePx?: number;
}

export interface ScopeLabelPlacement {
  id: string;
  kind: ScopeLabelKind;
  labelN: number;
  /** Display string — short Cn for live and ghosts (ghosts differ by size/opacity). */
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
const GHOST_PAD = 8;
const STAGGER_STEP = 16;
const MAX_STAGGER_STEPS = 8;
const RIM_INSET = 28;
const LEADER_MIN_DY = 10;

function textWidth(text: string, fontSize: number): number {
  return Math.max(1, text.length * fontSize * CHAR_W);
}

function labelText(_kind: ScopeLabelKind, labelN: number): string {
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

function preferLeft(x: number, cx: number, scopeR: number): boolean {
  return x > cx + scopeR * 0.35;
}

function clampTowardCenter(
  labelX: number,
  labelY: number,
  cx: number,
  cy: number,
  maxR: number,
): { x: number; y: number } {
  const dx = labelX - cx;
  const dy = labelY - cy;
  const dist = Math.hypot(dx, dy);
  if (dist <= maxR || dist < 1e-6) return { x: labelX, y: labelY };
  const s = maxR / dist;
  return { x: cx + dx * s, y: cy + dy * s };
}

function sideForBlip(
  req: ScopeLabelRequest,
  cx: number,
  cy: number,
  scopeR: number,
  pad: number,
  forceInward: boolean,
): { labelX: number; textAnchor: 'start' | 'end'; onLeft: boolean } {
  const blipDist = Math.hypot(req.x - cx, req.y - cy);
  const nearRim = blipDist > scopeR * 0.78;
  let onLeft = preferLeft(req.x, cx, scopeR);
  if (forceInward || nearRim) {
    // Prefer the side toward scope center (horizontal component).
    onLeft = req.x >= cx;
  }
  return {
    labelX: onLeft ? req.x - req.blipR - pad : req.x + req.blipR + pad,
    textAnchor: onLeft ? 'end' : 'start',
    onLeft,
  };
}

function overlapsAny(box: Box, others: Box[]): boolean {
  for (const o of others) {
    if (boxesOverlap(box, o)) return true;
  }
  return false;
}

function placeOne(
  req: ScopeLabelRequest,
  opts: Required<
    Pick<LayoutScopeLabelsOptions, 'cx' | 'cy' | 'scopeR' | 'fontSizeLive' | 'fontSizeGhost'>
  >,
  occupied: Box[],
): ScopeLabelPlacement {
  const fontSize = req.kind === 'ghost' ? opts.fontSizeGhost : opts.fontSizeLive;
  const pad = req.kind === 'ghost' ? GHOST_PAD : LIVE_PAD;
  const text = labelText(req.kind, req.labelN);
  const maxLabelR = opts.scopeR - RIM_INSET;

  const tryPlace = (forceInward: boolean, flip: boolean): ScopeLabelPlacement | null => {
    let side = sideForBlip(req, opts.cx, opts.cy, opts.scopeR, pad, forceInward);
    if (flip) {
      side = {
        onLeft: !side.onLeft,
        labelX: !side.onLeft ? req.x - req.blipR - pad : req.x + req.blipR + pad,
        textAnchor: !side.onLeft ? 'end' : 'start',
      };
    }

    for (let step = 0; step <= MAX_STAGGER_STEPS; step++) {
      const sign = step === 0 ? 0 : step % 2 === 1 ? -1 : 1;
      const mag = Math.ceil(step / 2) * STAGGER_STEP;
      const rawY = req.y + 5 + sign * mag;
      const clamped = clampTowardCenter(side.labelX, rawY, opts.cx, opts.cy, maxLabelR);
      const box = boxFor(clamped.x, clamped.y, side.textAnchor, text, fontSize);
      if (!overlapsAny(box, occupied)) {
        const dy = Math.abs(clamped.y - req.y);
        const dx = Math.abs(clamped.x - req.x);
        const needLeader = dy >= LEADER_MIN_DY || dx > req.blipR + pad + 6;
        const leader = needLeader
          ? {
              x1: req.x,
              y1: req.y,
              x2: side.onLeft ? box.right + 2 : box.left - 2,
              y2: clamped.y - 2,
            }
          : undefined;
        return {
          id: req.id,
          kind: req.kind,
          labelN: req.labelN,
          text,
          visible: true,
          labelX: clamped.x,
          labelY: clamped.y,
          textAnchor: side.textAnchor,
          fontSize,
          leader,
        };
      }
    }
    return null;
  };

  return (
    tryPlace(false, false) ??
    tryPlace(true, false) ??
    tryPlace(false, true) ??
    tryPlace(true, true) ?? {
      id: req.id,
      kind: req.kind,
      labelN: req.labelN,
      text,
      // Live always shows something; ghosts drop when no free slot.
      visible: req.kind === 'live',
      labelX: preferLeft(req.x, opts.cx, opts.scopeR)
        ? req.x - req.blipR - pad
        : req.x + req.blipR + pad,
      labelY: req.y + 5,
      textAnchor: preferLeft(req.x, opts.cx, opts.scopeR) ? 'end' : 'start',
      fontSize,
    }
  );
}

/**
 * Layout Contact-N labels for polar CRT scopes.
 * Live labels win; ghost labels are compact and drop when they would stack on live.
 */
export function layoutScopeContactLabels(
  requests: ScopeLabelRequest[],
  options: LayoutScopeLabelsOptions,
): ScopeLabelPlacement[] {
  const cx = options.cx;
  const cy = options.cy;
  const scopeR = options.scopeR;
  const fontSizeLive = options.fontSizeLive ?? 16;
  const fontSizeGhost = options.fontSizeGhost ?? 12;
  const ghostSuppressNearLivePx = options.ghostSuppressNearLivePx ?? 36;

  const liveReqs = requests.filter((r) => r.kind === 'live');
  const ghostReqs = requests.filter((r) => r.kind === 'ghost');

  // Stable visual order: closer to top of scope first so stagger fans downward.
  liveReqs.sort((a, b) => a.y - b.y || a.x - b.x || a.labelN - b.labelN);
  ghostReqs.sort((a, b) => a.y - b.y || a.x - b.x || a.labelN - b.labelN);

  const occupied: Box[] = (options.obstacles ?? []).map(obstacleBox);
  const out: ScopeLabelPlacement[] = [];
  const liveById = new Map<string, ScopeLabelRequest>();
  for (const r of liveReqs) liveById.set(r.id, r);

  const opts = { cx, cy, scopeR, fontSizeLive, fontSizeGhost };

  for (const req of liveReqs) {
    const placed = placeOne(req, opts, occupied);
    if (placed.visible) {
      occupied.push(
        boxFor(placed.labelX, placed.labelY, placed.textAnchor, placed.text, placed.fontSize),
      );
    }
    out.push(placed);
  }

  for (const req of ghostReqs) {
    const live = liveById.get(req.id);
    if (live) {
      const dist = Math.hypot(req.x - live.x, req.y - live.y);
      if (dist < ghostSuppressNearLivePx) {
        out.push({
          id: req.id,
          kind: 'ghost',
          labelN: req.labelN,
          text: labelText('ghost', req.labelN),
          visible: false,
          labelX: req.x,
          labelY: req.y,
          textAnchor: 'start',
          fontSize: fontSizeGhost,
        });
        continue;
      }
    }

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
