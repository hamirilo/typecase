// How the list looks: one popover on the toolbar ("表示") with the layout,
// the order, the grouping and what each grid tile shows. The sizes stay out on
// the specimen text row (docs/NAVIGATION.md「ツールバー」).
import { ALargeSmall, ArrowDownWideNarrow, ArrowUpNarrowWide, ChevronDown, LayoutGrid } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GroupBy } from "../lib/grouping";
import type { SortKey } from "../lib/api";
import { LIBRARY_GROUPS, shownGroupBy, useStore, type Layout, type ShowInfo } from "../store";

/** The groupings (the store's `GROUPS`), with their labels. */
export const GROUPS: { key: GroupBy; label: string; hint: string }[] = [
  { key: "none", label: "なし", hint: "区切らずに並べる" },
  { key: "category", label: "書体", hint: "明朝・ゴシック・丸ゴシック…に分ける" },
  { key: "script", label: "言語", hint: "日本語・欧文・中国語・韓国語に分ける" },
  { key: "month", label: "年月", hint: "追加した年月ごとに分ける（新しい順）" },
  { key: "rating", label: "評価", hint: "★5 から未評価まで" },
  { key: "tag", label: "タグ", hint: "複数のタグがあるものは各タグに出る" },
  { key: "folder", label: "フォルダ", hint: "「すべて」やサブフォルダ表示で便利" },
];

/** The layouts, in the order of the switch. */
export const LAYOUTS: { key: Layout; label: string; icon: React.ReactNode; hint: string }[] = [
  {
    key: "specimen",
    label: "見本",
    icon: <ALargeSmall size={15} />,
    hint: "フォントを 1 行ずつ大きく並べ、同じ文字で見比べる",
  },
  { key: "grid", label: "グリッド", icon: <LayoutGrid size={15} />, hint: "同じ大きさの枠に並べる" },
];

/** Sort keys, in the order offered. */
export const SORTS: { key: SortKey; label: string }[] = [
  { key: "importedAt", label: "追加日" },
  { key: "name", label: "名前" },
  { key: "size", label: "ファイルサイズ" },
  { key: "rating", label: "評価" },
  { key: "manual", label: "手動（ドラッグで並べ替え）" },
];

/** What a grid tile can show under it. */
const INFO: { key: keyof ShowInfo; label: string }[] = [
  { key: "name", label: "名前" },
  { key: "rating", label: "評価" },
  { key: "meta", label: "形式・容量" },
];

/** A toolbar button with a dropdown that closes on Escape or a click elsewhere. */
export function Dropdown({
  button,
  title,
  active,
  width,
  children,
}: {
  button: React.ReactNode;
  title: string;
  /** Highlighted: the setting differs from the default. */
  active?: boolean;
  width: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // Hangs from the button's right edge; when the toolbar is narrow (stacked)
  // that would run under the sidebar, so it moves right to stay inside the toolbar.
  useLayoutEffect(() => {
    if (!open || !panel.current) return setShift(0);
    const bar = ref.current?.closest("header")?.getBoundingClientRect();
    const box = panel.current.getBoundingClientRect();
    setShift(bar ? Math.max(0, bar.left + 8 - (box.left - shift)) : 0);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        title={title}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-7 items-center gap-1.5 rounded-md px-2 whitespace-nowrap ghost ${open ? "bg-press" : ""} ${
          active ? "text-accent" : ""
        }`}
      >
        {button}
      </button>
      {open && (
        <div
          ref={panel}
          style={shift ? { translate: `${shift}px 0` } : undefined}
          className={`absolute top-full right-0 z-40 mt-1 ${width} animate-slide-down rounded-lg border border-line bg-raised p-1 text-xs shadow-xl`}
          onClick={(e) => (e.target as HTMLElement).closest("[data-close]") && setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  );
}

const heading = "px-2 pt-1.5 pb-1 text-[11px] font-semibold text-dim";
const rule = "mx-1.5 my-1.5 border-t border-line";

/** A row of the popover: its name on the left, the control on the right. */
function Row({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-2 py-1.5" title={title}>
      <span className="w-16 shrink-0 whitespace-nowrap text-dim">{label}</span>
      <div className="flex min-w-0 flex-1 justify-end">{children}</div>
    </div>
  );
}

/** Choices side by side, one picked (macOS segmented control). */
function Segment<K extends string>({
  label,
  items,
  value,
  onPick,
}: {
  label: string;
  items: { key: K; label: React.ReactNode; title: string; disabled?: boolean }[];
  value: K | null;
  onPick: (k: K) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex h-7 w-full items-stretch rounded-md track">
      {items.map((i) => {
        const on = value === i.key && !i.disabled;
        return (
          <button
            key={i.key}
            disabled={i.disabled}
            aria-pressed={on}
            title={i.title}
            onClick={() => onPick(i.key)}
            className={`flex flex-1 items-center justify-center gap-1 rounded px-1.5 whitespace-nowrap disabled:off ${
              on ? "thumb font-medium" : "text-fg/85 enabled:hover:bg-hover enabled:hover:text-fg"
            }`}
          >
            {i.label}
          </button>
        );
      })}
    </div>
  );
}

/** The order and its direction. The installed fonts have no rating (docs/SYSTEM_FONTS.md). */
function SortControl() {
  const sort = useStore((s) => s.sort);
  const desc = useStore((s) => s.desc);
  const setSort = useStore((s) => s.setSort);
  const canManual = useStore((s) => s.view.kind === "folder");
  const isSystem = useStore((s) => s.view.kind === "system");
  const manual = sort === "manual";
  const label = manual ? "手動" : (SORTS.find((s) => s.key === sort)?.label ?? "");
  return (
    <div className="flex h-7 w-full items-stretch gap-1">
      {/* A native select over a label, so the arrow matches the rest. */}
      <label className="relative flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-edge pr-1.5 pl-2.5 whitespace-nowrap focus-within:border-accent">
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronDown size={14} className="shrink-0 text-dim" />
        <select
          aria-label="並び順"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey, desc)}
          className="absolute inset-0 cursor-default opacity-0"
        >
          {SORTS.map((s) => (
            <option
              key={s.key}
              value={s.key}
              disabled={(s.key === "manual" && !canManual) || (isSystem && s.key === "rating")}
            >
              {s.key === "manual" && !canManual
                ? "手動（フォルダのみ）"
                : isSystem && s.key === "rating"
                  ? "評価（ライブラリのフォントのみ）"
                  : s.label}
            </option>
          ))}
        </select>
      </label>
      <button
        title={manual ? "手動の並びは昇順のみ" : desc ? "降順（クリックで昇順）" : "昇順（クリックで降順）"}
        aria-label={desc ? "降順" : "昇順"}
        disabled={manual}
        onClick={() => setSort(sort, !desc)}
        className="flex w-8 shrink-0 items-center justify-center rounded-md border border-edge enabled:hover:bg-hover disabled:off"
      >
        {desc ? <ArrowDownWideNarrow size={15} /> : <ArrowUpNarrowWide size={15} />}
      </button>
    </div>
  );
}

/**
 * "表示": how the list looks, in one popover (docs/NAVIGATION.md「表示のポップオーバー」).
 * It stays open while things are picked, so several can be changed in a row;
 * a click elsewhere or Esc closes it. The rows are always the same (what
 * can't be used is greyed out).
 */
export function ViewPopover() {
  const layout = useStore((s) => s.layout);
  const setLayout = useStore((s) => s.setLayout);
  const groupBy = useStore(shownGroupBy);
  const setGroupBy = useStore((s) => s.setGroupBy);
  // The installed fonts have no rating, tags or folder (docs/SYSTEM_FONTS.md).
  const system = useStore((s) => s.view.kind === "system");
  const showInfo = useStore((s) => s.showInfo);
  const setShowInfo = useStore((s) => s.setShowInfo);
  const current = LAYOUTS.find((l) => l.key === layout) ?? LAYOUTS[0];
  return (
    <Dropdown
      title={`表示：${current.label}（レイアウト・並び順・グループ・表示する情報）`}
      width="w-[26rem]"
      button={
        <>
          {current.icon}
          <span className="@max-[50rem]:hidden">表示</span>
          <ChevronDown size={13} className="text-dim" />
        </>
      }
    >
      <Row label="レイアウト">
        <Segment
          label="レイアウト"
          value={layout}
          onPick={setLayout}
          items={LAYOUTS.map((l) => ({
            key: l.key,
            label: (
              <>
                {l.icon}
                {l.label}
              </>
            ),
            title: `${l.label}：${l.hint}`,
          }))}
        />
      </Row>
      <Row label="並び順">
        <SortControl />
      </Row>
      <Row label="グループ">
        <Segment
          label="グループ分け"
          value={groupBy}
          onPick={setGroupBy}
          items={GROUPS.map((g) => {
            const off = system && LIBRARY_GROUPS.includes(g.key);
            return {
              key: g.key,
              label: g.label,
              disabled: off,
              title: off
                ? `${g.label}：この端末のフォントには使えません（ライブラリのフォントだけ）`
                : `${g.label}：${g.hint}`,
            };
          })}
        />
      </Row>
      <div className={rule} />
      <div className={heading}>グリッドのタイルの下に表示</div>
      <div className="grid grid-cols-3 px-1 pb-1" title={layout === "grid" ? undefined : "グリッドのレイアウトで使えます"}>
        {INFO.map((i) => (
          <label key={i.key} className="flex cursor-default items-center gap-2 rounded px-1 py-1.5 hover:bg-ink/8">
            <input
              type="checkbox"
              checked={showInfo[i.key]}
              disabled={layout !== "grid"}
              onChange={(e) => setShowInfo({ [i.key]: e.target.checked })}
              className="accent-accent disabled:off"
            />
            {i.label}
          </label>
        ))}
      </div>
    </Dropdown>
  );
}
