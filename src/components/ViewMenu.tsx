// Toolbar controls for how the list looks, each on its own: the layout
// (one click), grouping into sections (one click), and what to show per tile.
import { ALargeSmall, Check, ChevronDown, Group, LayoutGrid, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { GroupBy } from "../lib/grouping";
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
  const ref = useRef<HTMLDivElement>(null);
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
          className={`absolute top-full right-0 z-40 mt-1 ${width} animate-slide-down rounded-lg border border-line bg-raised p-1 text-xs shadow-xl`}
          onClick={(e) => (e.target as HTMLElement).closest("[data-close]") && setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  );
}

const heading = "px-2 pt-1 pb-1 text-[11px] font-semibold text-dim";

/** The layouts side by side ([見本｜グリッド]), one click to switch. */
export function LayoutSwitch() {
  const layout = useStore((s) => s.layout);
  const setLayout = useStore((s) => s.setLayout);
  return (
    <div className="flex h-7 shrink-0 items-stretch rounded-md track @max-5xl:hidden">
      {LAYOUTS.map((l) => (
        <button
          key={l.key}
          title={`${l.label}：${l.hint}`}
          aria-label={l.label}
          aria-pressed={layout === l.key}
          onClick={() => setLayout(l.key)}
          className={`flex w-7 items-center justify-center rounded ${
            layout === l.key ? "thumb" : "text-fg/85 hover:bg-hover hover:text-fg"
          }`}
        >
          {l.icon}
        </button>
      ))}
    </div>
  );
}

/**
 * Splitting the list into sections: every choice side by side,
 * one click each, so nothing on the row moves when it changes (docs/UI.md).
 * When the toolbar is narrow the same choices fold into a menu in its place.
 */
export function GroupMenu() {
  const groupBy = useStore(shownGroupBy);
  // The installed fonts have no rating, tags or folder (docs/SYSTEM_FONTS.md).
  const system = useStore((s) => s.view.kind === "system");
  const off = (g: GroupBy) => system && LIBRARY_GROUPS.includes(g);
  const setGroupBy = useStore((s) => s.setGroupBy);
  const groups = GROUPS;
  const current = groups.find((g) => g.key === groupBy) ?? groups[0];
  return (
    <div className="flex h-7 shrink-0 items-center gap-1.5">
      <span className="text-dim @max-2xl:hidden">グループ</span>
      {/* Narrow: a native select over a label, like the sort order next to it. */}
      <label
        title={`グループ分け：${current.hint}`}
        className="relative hidden h-full items-center gap-1.5 rounded-md pr-2 pl-2.5 whitespace-nowrap ghost focus-within:border-accent @max-2xl:flex"
      >
        <span className="text-dim @max-md:hidden">グループ</span>
        <Group size={14} className="hidden text-dim @max-md:block" />
        {current.label}
        <ChevronDown size={14} className="text-dim" />
        <select
          aria-label="グループ分け"
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value as GroupBy)}
          className="absolute inset-0 cursor-default opacity-0"
        >
          {groups.map((g) => (
            <option key={g.key} value={g.key} disabled={off(g.key)}>
              {g.label}
            </option>
          ))}
        </select>
      </label>
      <div role="group" aria-label="グループ分け" className="flex h-full items-stretch rounded-md track @max-2xl:hidden">
        {groups.map((g) => {
          const on = groupBy === g.key;
          return (
            <button
              key={g.key}
              disabled={off(g.key)}
              aria-pressed={on}
              title={
                off(g.key)
                  ? `${g.label}：この端末のフォントには使えません（ライブラリのフォントだけ）`
                  : `${g.label}：${g.hint}`
              }
              onClick={() => setGroupBy(g.key)}
              className={`rounded px-2 whitespace-nowrap disabled:off ${
                on ? "thumb font-medium" : "text-fg/85 enabled:hover:bg-hover enabled:hover:text-fg"
              }`}
            >
              {g.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The layout and the information shown under each tile. The sizes are on the specimen text row. */
export function DisplayMenu() {
  const showInfo = useStore((s) => s.showInfo);
  const setShowInfo = useStore((s) => s.setShowInfo);
  const layout = useStore((s) => s.layout);
  const setLayout = useStore((s) => s.setLayout);
  return (
    <Dropdown title="表示（レイアウト・表示する情報）" width="w-64" button={<SlidersHorizontal size={15} />}>
      <div className={heading}>レイアウト</div>
      {LAYOUTS.map((l) => (
        <button
          key={l.key}
          data-close
          onClick={() => setLayout(l.key)}
          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-white/8 ${
            layout === l.key ? "text-fg" : "text-dim"
          }`}
        >
          <span className={`shrink-0 ${layout === l.key ? "text-accent" : ""}`}>{l.icon}</span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span>{l.label}</span>
            <span className="text-[11px] text-dim">{l.hint}</span>
          </span>
          {layout === l.key && <Check size={13} className="shrink-0 text-accent" />}
        </button>
      ))}
      <div className="mx-1.5 my-1 border-t border-line" />
      <div className={heading}>グリッドのタイルの下に表示</div>
      {INFO.map((i) => (
        <label key={i.key} className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 hover:bg-white/8">
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
    </Dropdown>
  );
}
