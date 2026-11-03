// Layout math for the font list. Every layout turns the items into absolute
// boxes (content coordinates) so the grid can virtualize, hit-test and
// navigate them the same way.
import type { Item } from "./api";
import type { Section } from "./grouping";
import type { Layout, ShowInfo } from "../store";

export const PAD = 16;
export const GAP = 12;
/** Band above each section (style, writing system, rating, tag, folder). */
export const HEADER = 40;

/** Specimen layout: a font's row, its name line plus the sample at `size` px. */
export const specimenRow = (size: number) => 34 + Math.round(size * 1.3);

/** Thumbnail box; the label (if any) sits below it. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Placement {
  boxes: Box[];
  /** Section header bands, `y` = top of the band, `start` = first item. */
  headers: { y: number; start: number }[];
  /** Total content height. */
  height: number;
  /** Height of the text under each tile (0 in the specimen layout). */
  label: number;
}

/** Text lines under tiles: name, then one line for rating / type. */
export function labelHeight(info: ShowInfo): number {
  const lines = (info.name ? 1 : 0) + (info.rating || info.meta ? 1 : 0);
  return lines === 0 ? 0 : 6 + lines * 15;
}

/** [start, end) of each section, or one segment when the list isn't sectioned. */
function segments(items: Item[], sections: Section[]): [number, number][] {
  if (sections.length) return sections.map((s) => [s.start, s.end]);
  return items.length ? [[0, items.length]] : [];
}

/** Column count / width for a target cell size. */
function columns(inner: number, target: number) {
  const cols = Math.max(1, Math.floor((inner + GAP) / (target + GAP)));
  const w = Math.floor((inner - GAP * (cols - 1)) / cols);
  return { cols, w };
}

export function computeLayout(
  kind: Layout,
  items: Item[],
  inner: number,
  target: number,
  info: ShowInfo,
  sections: Section[] = [],
): Placement {
  const label = kind === "specimen" ? 0 : labelHeight(info);
  const boxes: Box[] = new Array(items.length);
  const headers: { y: number; start: number }[] = [];
  const grouped = sections.length > 0;
  let y = PAD;

  for (const [start, end] of segments(items, sections)) {
    if (grouped) {
      headers.push({ y, start });
      y += HEADER;
    }
    if (kind === "grid") y = grid(start, end, inner, target, label, y, boxes);
    else y = specimen(start, end, inner, target, y, boxes);
  }
  return { boxes, headers, height: y + PAD, label };
}

/** Grid: equal square cells. */
function grid(from: number, end: number, inner: number, target: number, label: number, top: number, boxes: Box[]) {
  const { cols, w } = columns(inner, target);
  for (let k = from; k < end; k++) {
    const r = Math.floor((k - from) / cols);
    const c = (k - from) % cols;
    boxes[k] = { x: PAD + c * (w + GAP), y: top + r * (w + label + GAP), w, h: w };
  }
  const rows = Math.ceil((end - from) / cols);
  return top + rows * (w + label + GAP);
}

/**
 * Specimen: one full-width row per font, tall enough to show its sample at
 * `size` (the specimen size, in place of the tile size).
 */
function specimen(from: number, end: number, inner: number, size: number, top: number, boxes: Box[]) {
  const h = specimenRow(size);
  for (let k = from; k < end; k++) {
    boxes[k] = { x: PAD, y: top, w: inner, h };
    top += h;
  }
  return top;
}

/** Item indices whose box (plus label) intersects [top, bottom]. */
export function visibleRange(p: Placement, top: number, bottom: number): number[] {
  const out: number[] = [];
  p.boxes.forEach((b, i) => {
    if (b.y <= bottom && b.y + b.h + p.label >= top) out.push(i);
  });
  return out;
}

/**
 * Keyboard navigation target from `cur`: ←/→ step through the order, ↑/↓
 * pick the nearest box above / below (by centre), so it works for every layout.
 */
export function neighbour(p: Placement, cur: number, dir: "up" | "down"): number {
  const a = p.boxes[cur];
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  let best = -1;
  let bestScore = Infinity;
  p.boxes.forEach((b, i) => {
    if (i === cur) return;
    const by = b.y + b.h / 2;
    const below = by > ay + 1 && b.y >= a.y + a.h / 2;
    const above = by < ay - 1 && b.y + b.h <= a.y + a.h / 2;
    if ((dir === "down" && !below) || (dir === "up" && !above)) return;
    // Prefer the closest row, then the closest column.
    const score = Math.abs(by - ay) * 4 + Math.abs(b.x + b.w / 2 - ax);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best < 0 ? cur : best;
}
