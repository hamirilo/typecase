import { ChevronDown, FilePlus2, Star } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { exportSelection, importFilesDialog, setRating } from "../lib/actions";
import { runKey } from "../lib/commands";
import { commandIcon, commandItem } from "../lib/menuItems";
import { FontTile, SpecimenRow } from "../features/fonts/FontRows";
import { api, isSystemId, type Item } from "../lib/api";
import { fontApi } from "../features/fonts/api";
import { colorHex } from "../lib/colors";
import { rowIds, type Section } from "../lib/grouping";
import { computeLayout, HEADER, neighbour, PAD, visibleRange, type Placement } from "../lib/layouts";
import { activeConditions, currentFolderId, useStore, type ShowInfo } from "../store";
import { useMenu, type MenuItem } from "./ContextMenu";
import { startPointerDrag } from "./DragLayer";

/** Extra rows rendered above / below the viewport. */
const OVERSCAN = 600;

/**
 * Display index of the focused item. With tag grouping a font can appear
 * more than once, so the position it was clicked / moved to is remembered
 * and preferred over the first occurrence.
 */
let focusAt: number | null = null;
function focusIndex(s: { items: Item[]; focus: string | null }): number {
  if (focusAt !== null && s.items[focusAt]?.id === s.focus) return focusAt;
  return s.items.findIndex((i) => i.id === s.focus);
}

export function onItemPointerDown(e: React.PointerEvent, item: Item, index: number) {
  if (e.button !== 0) return;
  e.stopPropagation();
  focusAt = index;
  const s = useStore.getState();
  const mod = e.metaKey || e.ctrlKey;
  if (e.shiftKey) s.select(item.id, "range", index);
  else if (mod) s.select(item.id, "toggle", index);
  else if (!s.selected.has(item.id)) s.select(item.id, "only", index);
  // The installed fonts are dragged to the shelf only, not to folders or out of
  // the app as files (DragLayer.tsx, docs/SYSTEM_FONTS.md).
  startPointerDrag(
    e,
    () => ({ kind: "items", ids: [...useStore.getState().selected] }),
    // Plain click on an already-selected item narrows the selection to it.
    () => !e.shiftKey && !mod && useStore.getState().select(item.id, "only", index),
  );
}

export type CellProps = {
  item: Item;
  index: number;
  selected: boolean;
  /** The keyboard position, marked when it isn't the only selected item. */
  focused: boolean;
  dimmed: boolean;
  width: number;
  height: number;
  label: number;
  info: ShowInfo;
  /** Manual-order folder view: the cell is a drop target for reordering. */
  reorderable: boolean;
  /** Where the reorder drop indicator is shown, if here. */
  insert: "before" | "after" | null;
  /** Show the favourite / pin marks (not in the trash or the installed fonts). */
  flags: boolean;
};

/**
 * Selection of a row (specimen): a tint plus an accent bar on the left,
 * so it shows even where the row's own content is blue; the keyboard position
 * gets a light outline.
 */
export const rowSelection = (selected: boolean, focused: boolean) =>
  `${
    selected
      ? "bg-accent/25 text-white before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-full before:bg-accent"
      : "hover:bg-white/5"
  } ${focused ? "outline-1 -outline-offset-1 outline-fg/60" : ""}`;

export function Stars({ n, size = 9 }: { n: number; size?: number }) {
  return (
    <span className="flex text-amber-400" title={`★${n}`}>
      {Array.from({ length: n }, (_, i) => (
        <Star key={i} size={size} fill="currentColor" strokeWidth={0} />
      ))}
    </span>
  );
}

/** The menu of an item (and the rest of the selection); also the details panel's "…". */
export function showItemMenu(e: React.MouseEvent | { clientX: number; clientY: number }, item: Item, index: number) {
  const s0 = useStore.getState();
  if (!s0.selected.has(item.id)) s0.select(item.id, "only", index);
  const s = useStore.getState();
  const ids = [...s.selected];
  const header: MenuItem[] = ids.length > 1 ? [{ header: `${ids.length} 件を選択中` }] : [];
  if (s.view.kind === "trash") {
    useMenu.getState().show(e, [
      ...header,
      { label: "復元", onClick: () => s.run(() => api.restoreItems(ids)) },
      commandItem("item.trash", { label: "完全に削除", danger: true }),
    ]);
    return;
  }
  if (ids.some(isSystemId)) {
    // Installed fonts: looked at only (docs/SYSTEM_FONTS.md).
    useMenu.getState().show(e, [
      ...header,
      commandItem("item.show", { onClick: () => s.openViewer(index) }),
      commandItem("item.reveal", { onClick: () => s.run(() => fontApi.revealSystem(item.id)) }),
      commandItem("item.tray"),
      { separator: true },
      {
        header: "この端末のフォントは読み取り専用です。評価・タグ・フォルダはライブラリのフォントだけに使えます",
      },
    ]);
    return;
  }
  const byId = new Map(s.rawItems.map((i) => [i.id, i]));
  const ratings = new Set(ids.map((id) => byId.get(id)?.rating ?? 0));
  const folder = currentFolderId();
  useMenu.getState().show(e, [
    ...header,
    commandItem("item.show", { onClick: () => s.openViewer(index) }),
    commandItem("item.open"),
    commandItem("item.reveal", { onClick: () => s.run(() => api.revealItem(item.id)) }),
    { separator: true },
    {
      icons: ["item.favorite", "item.pin", "item.tray"].map(commandIcon),
      rating: { current: ratings.size === 1 ? [...ratings][0] : null, onPick: (n) => setRating(ids, n) },
    },
    { separator: true },
    commandItem("item.copy"),
    {
      label: "書き出し",
      submenu: [
        commandItem("list.export", { onClick: () => exportSelection(ids) }),
        commandItem("list.transfer", { onClick: () => s.setTransfer({ ids, count: ids.length }) }),
      ],
    },
    {
      label: "フォルダ",
      submenu: [
        commandItem("item.moveTo"),
        ...(s.recentFolders[0] ? [commandItem("item.moveToLast")] : []),
        commandItem("item.newFolder"),
        ...(folder ? [commandItem("item.unfile")] : []),
      ],
    },
    { label: "タグ", submenu: [commandItem("item.copyTags"), commandItem("item.pasteTags")] },
    { separator: true },
    commandItem("item.trash", { danger: true }),
  ]);
}

type Rect = { x1: number; y1: number; x2: number; y2: number };

export function Grid() {
  const items = useStore((s) => s.items);
  const sections = useStore((s) => s.sections);
  const selected = useStore((s) => s.selected);
  // Marked only where it tells something: beside other selected items, or unselected.
  const focus = useStore((s) => (s.focus && (s.selected.size > 1 || !s.selected.has(s.focus)) ? s.focus : null));
  const specimenSize = useStore((s) => s.specimenSize);
  const tileSize = useStore((s) => s.tileSize);
  const kind = useStore((s) => s.layout);
  const groupBy = useStore((s) => s.groupBy);
  const info = useStore((s) => s.showInfo);
  const viewKind = useStore((s) => s.view.kind);
  const filtering = useStore((s) => activeConditions(s) > 0);
  const dragIds = useStore((s) => (s.drag?.kind === "items" ? s.drag.ids : null));
  const dragging = useMemo(() => new Set(dragIds ?? []), [dragIds]);
  const reorderable = useStore(
    (s) => s.sort === "manual" && s.view.kind === "folder" && !s.showSubfolders,
  );
  const dropTarget = useStore((s) => (s.drag?.kind === "items" ? s.dropTarget : null));
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  const [marquee, setMarquee] = useState<Rect | null>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      setWidth(el.clientWidth);
      setViewport({ top: el.scrollTop, height: el.clientHeight });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  const inner = Math.max(0, width - PAD * 2);
  const placement = useMemo<Placement>(
    () =>
      inner > 0
        ? computeLayout(kind, items, inner, kind === "specimen" ? specimenSize : tileSize, info, sections)
        : { boxes: [], headers: [], height: 0, label: 0 },
    [kind, items, inner, specimenSize, tileSize, info, sections],
  );
  const visible = useMemo(
    () => visibleRange(placement, viewport.top - OVERSCAN, viewport.top + viewport.height + OVERSCAN),
    [placement, viewport],
  );

  const layout = useRef({ placement, items });
  layout.current = { placement, items };

  // Re-render on scroll, at most once per frame.
  const frame = useRef(0);
  const onScroll = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const el = scrollRef.current;
      if (el) setViewport({ top: el.scrollTop, height: el.clientHeight });
    });
  };

  /** Scrolls item `i` into view. */
  const reveal = (i: number) => {
    const el = scrollRef.current;
    const b = layout.current.placement.boxes[i];
    if (!el || !b) return;
    const bottom = b.y + b.h + layout.current.placement.label;
    if (b.y - PAD < el.scrollTop) el.scrollTop = b.y - PAD;
    else if (bottom + PAD > el.scrollTop + el.clientHeight) el.scrollTop = bottom + PAD - el.clientHeight;
  };

  // Keep the focused item on screen when the layout or grouping is switched.
  // Not on every refresh (`sections` is new each time): changing another
  // item, or thumbnails arriving, would pull the list back to it.
  useEffect(() => {
    const i = focusIndex(useStore.getState());
    if (i >= 0) reveal(i);
  }, [kind, groupBy]);

  /** Ids of cells intersecting a rectangle in content coordinates (a family row: all its fonts). */
  const hitTest = (r: Rect): string[] => {
    const { placement, items } = layout.current;
    const top = Math.min(r.y1, r.y2);
    const bottom = Math.max(r.y1, r.y2);
    const left = Math.min(r.x1, r.x2);
    const right = Math.max(r.x1, r.x2);
    const hits: string[] = [];
    placement.boxes.forEach((b, i) => {
      if (b.x <= right && b.x + b.w >= left && b.y <= bottom && b.y + b.h + placement.label >= top) {
        hits.push(...rowIds([items[i]]));
      }
    });
    return hits;
  };

  // Rubber-band selection on empty space; Shift/Cmd/Ctrl adds to the selection.
  const onBackgroundPointerDown = (e: React.PointerEvent) => {
    const el = scrollRef.current;
    if (e.button !== 0 || !el) return;
    const box = el.getBoundingClientRect();
    if (e.clientX - box.left >= el.clientWidth) return; // scrollbar
    const s = useStore.getState();
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const base = additive ? [...s.selected] : [];
    if (!additive) s.setSelection([]);
    const toContent = (cx: number, cy: number) => ({
      x: cx - box.left,
      y: cy - box.top + el.scrollTop,
    });
    const start = toContent(e.clientX, e.clientY);
    let pointer = { x: e.clientX, y: e.clientY };
    let moved = false;
    let raf = 0;

    const update = () => {
      const cur = toContent(pointer.x, pointer.y);
      const r = { x1: start.x, y1: start.y, x2: cur.x, y2: cur.y };
      setMarquee(r);
      const hits = new Set(hitTest(r));
      // In list order, so the keyboard goes on from the last one.
      const ids = new Set([...base, ...rowIds(layout.current.items).filter((id) => hits.has(id))]);
      useStore.getState().setSelection([...ids]);
    };
    // Scroll while the pointer is held near the top/bottom edge.
    const tick = () => {
      const edge = 40;
      const dy =
        pointer.y < box.top + edge
          ? -(box.top + edge - pointer.y)
          : pointer.y > box.bottom - edge
            ? pointer.y - (box.bottom - edge)
            : 0;
      if (dy) {
        el.scrollTop += dy / 3;
        update();
      }
      raf = requestAnimationFrame(tick);
    };
    const move = (ev: PointerEvent) => {
      pointer = { x: ev.clientX, y: ev.clientY };
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
      if (!moved) {
        moved = true;
        raf = requestAnimationFrame(tick);
      }
      update();
    };
    const up = () => {
      cancelAnimationFrame(raf);
      setMarquee(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Keyboard shortcuts for the list (Eagle-compatible where possible).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as Element).closest?.("input, textarea, select")) return;
      const s = useStore.getState();
      // A dialog, menu or panel is over the list (each marks its overlay
      // `data-modal`): Delete there must not trash the selection behind it.
      if (s.viewer !== null || s.drag || s.picker || s.settingsTab || s.exporting || s.transfer) return;
      if (document.querySelector("[data-modal]")) return;
      const sel = () => [...useStore.getState().selected];

      // Everything with a command (commands.ts): the same table as the menus.
      if (runKey(e)) return;
      const mod = e.metaKey || e.ctrlKey;
      const handled = () => e.preventDefault();

      // Ratings: 0-5, Shift+number rates and moves to the next font.
      const digit = /^(Digit|Numpad)([0-5])$/.exec(e.code);
      if (digit && !mod && !e.altKey) {
        handled();
        const ids = sel();
        if (!ids.length) return;
        void setRating(ids, Number(digit[2]));
        if (e.shiftKey) move(1, false);
        return;
      }

      const cur = focusIndex(s);
      const delta: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -2, ArrowDown: 2 };
      // A / D act like ← / → (Shift+D is "add to last folder" above).
      const key = !mod && !e.shiftKey && e.code === "KeyA" ? "ArrowLeft" : !mod && !e.shiftKey && e.code === "KeyD" ? "ArrowRight" : e.key;
      if (key in delta && !mod) {
        handled();
        move(delta[key], e.shiftKey);
      } else if ((e.key === " " || e.key === "Enter") && !mod && cur >= 0) {
        handled();
        s.openViewer(cur);
      }
    };
    /** ±1 = previous/next item, ±2 = the box above/below (layout-aware). */
    const move = (d: number, extend: boolean) => {
      const s = useStore.getState();
      const { placement } = layout.current;
      if (!s.items.length || !placement.boxes.length) return;
      const cur = focusIndex(s);
      let next: number;
      if (cur < 0) next = 0;
      else if (Math.abs(d) === 1) next = Math.min(s.items.length - 1, Math.max(0, cur + d));
      else next = neighbour(placement, cur, d < 0 ? "up" : "down");
      focusAt = next;
      s.select(s.items[next].id, extend ? "range" : "only", next);
      reveal(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const Comp = kind === "specimen" ? SpecimenRow : FontTile;
  // The section being read: the last one whose band has reached the top.
  const current = Math.max(0, placement.headers.filter((h) => h.y - PAD <= viewport.top + 4).length - 1);
  const jump = (n: number) => {
    const h = placement.headers[n];
    if (h) scrollRef.current?.scrollTo({ top: Math.max(0, h.y - PAD) });
    useStore.getState().setTocOpen(false);
  };
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {items.length > 0 && <SectionBar items={items} sections={sections} current={current} onJump={jump} />}
    <div
      ref={scrollRef}
      className="@container relative min-h-0 flex-1 overflow-y-auto"
      onScroll={onScroll}
      onPointerDown={onBackgroundPointerDown}
    >
      {items.length === 0 ? (
        <Empty kind={viewKind} filtering={filtering} />
      ) : (
        <div style={{ height: placement.height, position: "relative" }}>
          {marquee && (
            <div
              className="pointer-events-none absolute z-10 rounded-sm border border-accent bg-accent/15"
              style={{
                left: Math.min(marquee.x1, marquee.x2),
                top: Math.min(marquee.y1, marquee.y2),
                width: Math.abs(marquee.x2 - marquee.x1),
                height: Math.abs(marquee.y2 - marquee.y1),
              }}
            />
          )}
          {placement.headers.map((h, n) => (
            <div key={`h${h.start}`} className="absolute left-0" style={{ top: h.y, width }}>
              <SectionHeader items={items} section={sections[n]} />
            </div>
          ))}
          {visible.map((i) => {
            const item = items[i];
            const b = placement.boxes[i];
            return (
              // With tag grouping a font can appear in several sections.
              <div key={`${item.id}:${i}`} className="absolute" style={{ left: b.x, top: b.y }}>
                <Comp
                  item={item}
                  index={i}
                  selected={selected.has(item.id)}
                  focused={item.id === focus}
                  dimmed={dragging.has(item.id)}
                  width={b.w}
                  height={b.h}
                  label={placement.label}
                  info={info}
                  reorderable={reorderable}
                  insert={
                    dropTarget?.startsWith(`item:${item.id}:`)
                      ? dropTarget.endsWith("before")
                        ? "before"
                        : "after"
                      : null
                  }
                  flags={viewKind !== "trash" && viewKind !== "system"}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
    </div>
  );
}

/**
 * Above the list, outside its scrolling: the section being read, and the
 * table of contents to jump to any other. One row whether or not the list is
 * in sections, so nothing below moves (docs/UI.md, docs/GROUP_TOC.md).
 */
function SectionBar({
  items,
  sections,
  current,
  onJump,
}: {
  items: Item[];
  sections: Section[];
  current: number;
  onJump: (n: number) => void;
}) {
  const open = useStore((s) => s.tocOpen);
  const setOpen = useStore((s) => s.setTocOpen);
  const grouped = sections.length > 0;
  const count = (s: Section) => `${s.end - s.start} 件`;
  const here = grouped
    ? sections[Math.min(current, sections.length - 1)]
    : null;
  const menu = useRef<HTMLDivElement>(null);

  // Closes on a click elsewhere or Esc; the list keeps its keys meanwhile.
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (
        e instanceof KeyboardEvent
          ? e.key === "Escape"
          : !menu.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open, setOpen]);
  // The sections went away (grouping switched off): nothing to show open.
  useEffect(() => {
    if (!grouped && open) setOpen(false);
  }, [grouped, open, setOpen]);

  return (
    <div
      ref={menu}
      className="relative z-10 flex h-8 shrink-0 items-center gap-2 border-b border-line px-4 text-xs"
    >
      <span className="truncate font-semibold">{here?.title ?? "すべて"}</span>
      <span className="shrink-0 tabular-nums text-dim">
        {here ? count(here) : `${items.length} 件`}
      </span>
      <button
        disabled={!grouped}
        title={
          grouped ? "グループの目次（⌘⌥J）" : "グループ分けを選ぶと使えます"
        }
        onClick={() => setOpen(!open)}
        className="ml-auto flex min-w-20 items-center justify-center gap-1 rounded-md px-2 py-0.5 ghost disabled:off"
      >
        目次 <ChevronDown size={12} />
      </button>
      {open && (
        <div
          data-modal
          className="absolute right-4 top-8 max-h-80 w-60 overflow-y-auto rounded-lg border border-line bg-panel p-1 shadow-xl"
        >
          {sections.map((s, n) => {
            const hex = colorHex(s.color);
            return (
              <button
                key={`${s.start}:${n}`}
                onClick={() => onJump(n)}
                className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-white/10 ${n === current ? "bg-white/10 font-semibold" : ""}`}
              >
                {hex && (
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: hex }}
                  />
                )}
                {s.rating ? (
                  <Stars n={s.rating} size={12} />
                ) : (
                  <span className="truncate">{s.title}</span>
                )}
                <span className="ml-auto shrink-0 tabular-nums text-dim">
                  {count(s)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Band above a rating / tag / folder section; clicking it selects the section. */
function SectionHeader({ items, section }: { items: Item[]; section: Section }) {
  const { start, end, title, color, rating } = section;
  const hex = colorHex(color);
  return (
    <div
      className={`flex cursor-default items-center gap-2 text-xs ${start > 0 ? "border-t border-line" : ""}`}
      style={{ height: HEADER - 8, marginLeft: PAD, marginRight: PAD, marginBottom: 8 }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => useStore.getState().setSelection(rowIds(items.slice(start, end)))}
      title="クリックでこの区切りをすべて選択"
    >
      {rating !== undefined && rating > 0 ? <Stars n={rating} size={12} /> : null}
      {hex && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: hex }} />}
      <span className={`truncate font-semibold ${rating === 0 ? "text-dim" : ""}`}>
        {rating !== undefined && rating > 0 ? "" : title}
      </span>
      <span className="shrink-0 text-dim tabular-nums">
        {end - start} 件
      </span>
    </div>
  );
}

function Empty({ kind, filtering }: { kind: string; filtering: boolean }) {
  const systemCount = useStore((s) => s.systemCount);
  if (kind === "trash") return <p className="mt-24 text-center text-dim">ゴミ箱は空です</p>;
  if (filtering)
    return (
      <div className="mt-24 flex flex-col items-center gap-3 text-dim">
        <p>条件に合うフォントはありません</p>
        <button
          onClick={() => useStore.getState().clearConditions()}
          className="rounded-md bg-accent-fill px-3 py-1.5 font-medium text-white hover:brightness-110"
        >
          絞り込みをすべて解除
        </button>
      </div>
    );
  if (kind === "system")
    return (
      <p className="mt-24 text-center text-dim">
        {systemCount === null
          ? "この端末のフォントを読み込んでいます…（初めてのときは時間がかかります）"
          : "この端末のフォントは見つかりませんでした"}
      </p>
    );
  if (kind === "unfiled" || kind === "untagged")
    return <p className="mt-24 text-center text-dim">該当するフォントはありません</p>;
  if (kind === "favorites")
    return (
      <p className="mt-24 text-center text-dim">
        お気に入りはまだありません。フォントを選んで F キー、または一覧のハートで追加できます
      </p>
    );
  if (kind === "pinned")
    return (
      <p className="mt-24 text-center text-dim">
        ピン留めしたフォントはありません。フォントを選んで P キーでピン留めすると、どの一覧でも先頭に表示されます
      </p>
    );
  if (kind === "folder")
    return (
      <div className="mt-24 flex flex-col items-center gap-2 text-dim">
        <FilePlus2 size={40} strokeWidth={1.25} />
        <p>このフォルダは空です</p>
        <p className="text-xs">フォントをサイドバーのフォルダへドラッグするか、ここにファイルをドロップして追加</p>
      </div>
    );
  return (
    <div className="mt-24 flex flex-col items-center gap-3 text-dim">
      <FilePlus2 size={40} strokeWidth={1.25} />
      <p>フォントファイル（TTF・OTF・WOFF・WOFF2・TTC）やフォルダをここにドラッグ&ドロップ</p>
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={importFilesDialog}
        className="rounded-md bg-accent-fill px-4 py-1.5 font-medium text-white hover:brightness-110"
      >
        フォントを選択して追加
      </button>
    </div>
  );
}
