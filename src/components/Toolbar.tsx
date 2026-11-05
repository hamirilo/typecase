import {
  ArrowDownWideNarrow,
  ArrowUpDown,
  ArrowUpNarrowWide,
  ChevronDown,
  FolderSearch,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Search,
  Sun,
  Tag as TagIcon,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { dragRegion } from "../lib/titleBar";
import { emptyTrash } from "../lib/actions";
import { SpecimenControls } from "../features/fonts/SpecimenControls";
import { reloadSystemFonts } from "../features/fonts/system";
import { fontCategoryLabel, fontScriptLabel, type Folder, type SmartFolder, type SortKey, type Tag, type View } from "../lib/api";
import { colorHex } from "../lib/colors";
import { command } from "../lib/commands";
import { appearanceLabel, nextAppearance, parseAppearance } from "../lib/appearance";
import { activeConditions, placeTotal, useStore } from "../store";
import { composing } from "../lib/ime";
import { FilterRow } from "./FilterRow";
import { DisplayMenu, GroupMenu, LayoutSwitch } from "./ViewMenu";

/** Thin line between groups of controls. */
const Divider = ({ className = "" }: { className?: string }) => (
  <div className={`mx-0.5 h-5 w-px shrink-0 bg-line ${className}`} />
);

export const SORTS: { key: SortKey; label: string }[] = [
  { key: "importedAt", label: "追加日" },
  { key: "name", label: "名前" },
  { key: "size", label: "ファイルサイズ" },
  { key: "rating", label: "評価" },
  { key: "manual", label: "手動（ドラッグで並べ替え）" },
];

const SEARCH_HELP =
  [
    "名前・ファミリー名・メモ・タグを検索",
    "  空白区切り … すべてを含む",
    "  -語 … 除外",
    "  A OR B / A || B … どちらか",
    "  ( ) … グループ化、\"語句\" … 完全一致",
  ].join("\n");

function viewTitle(view: View, folders: Folder[], smart: SmartFolder[], tags: Tag[]): string {
  switch (view.kind) {
    case "all":
      return "すべてのフォント";
    case "unfiled":
      return "未分類";
    case "untagged":
      return "タグなし";
    case "trash":
      return "ゴミ箱";
    case "favorites":
      return "お気に入り";
    case "pinned":
      return "ピン留め";
    case "tray":
      return "シェルフ";
    case "folder":
      return folders.find((f) => f.id === view.id)?.name ?? "";
    case "smart":
      return smart.find((f) => f.id === view.id)?.name ?? "";
    case "tag":
      return tags.find((t) => t.id === view.id)?.name ?? "";
    case "fontScript":
      return fontScriptLabel(view.id);
    case "fontCategory":
      return fontCategoryLabel(view.id);
    case "system":
      return "この端末のフォント";
  }
}

export function Toolbar() {
  const search = useStore((s) => s.search);
  const setSearch = useStore((s) => s.setSearch);
  const tags = useStore((s) => s.tags);
  // Number of fonts (with tag grouping a font can be listed more than once).
  const count = useStore((s) => s.rawItems.length);
  const selectedCount = useStore((s) => s.selected.size);
  const setSelection = useStore((s) => s.setSelection);
  const view = useStore((s) => s.view);
  const folders = useStore((s) => s.folders);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const smartFolders = useStore((s) => s.smartFolders);
  const editingSmart = useStore((s) => s.editingSmart);
  const conditions = useStore(activeConditions);
  // "5 / 13 件" while narrowed: of the place's items without conditions.
  const total = useStore((s) => (activeConditions(s) > 0 ? placeTotal(s) : null));
  const smart = view.kind === "smart" ? smartFolders.find((f) => f.id === view.id) : undefined;

  // Debounce typing so each keystroke doesn't hit the DB.
  const [text, setText] = useState(search);
  useEffect(() => setText(search), [search]);
  useEffect(() => {
    if (text === search) return;
    const t = setTimeout(() => setSearch(text), 200);
    return () => clearTimeout(t);
  }, [text, search, setSearch]);

  return (
    <header
      {...dragRegion(true)}
      className="@container flex flex-col gap-2 border-b border-line bg-panel px-4 py-2 transition-[padding] duration-200 ease-out"
      // With the sidebar closed, the macOS window buttons are over this bar.
      style={sidebarOpen ? undefined : { paddingLeft: "max(1rem, var(--traffic-lights))" }}
    >
      {/* Collapses progressively by toolbar width (container queries) so nothing
          overflows into the inspector: label → slider → two rows. */}
      <div className="flex items-center gap-x-3 gap-y-2 @max-xl:flex-col @max-xl:items-stretch">
        {/* Sized to its content; the right side takes the rest, so short of room the
            search box gives way first, then the title (never the count or the actions). */}
        <div className="flex items-center gap-2">
          <button
            title={`サイドバーを${sidebarOpen ? "隠す" : "表示"}（Tab / ⌘⌥1）`}
            onClick={toggleSidebar}
            className={`-ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-ink/5 ${
              sidebarOpen ? "text-dim" : "text-accent"
            }`}
          >
            {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          </button>
          <h1 className="flex items-baseline gap-2 text-base font-semibold">
            {smart && <FolderSearch size={15} className="shrink-0 self-center text-accent" />}
            {view.kind === "tag" && (
              <TagIcon
                size={15}
                className="shrink-0 self-center"
                style={{ color: colorHex(tags.find((t) => t.id === view.id)?.color) }}
              />
            )}
            <span className="truncate">
              {editingSmart ? `「${editingSmart.name}」の条件` : viewTitle(view, folders, smartFolders, tags)}
            </span>
            {selectedCount > 0 ? (
              <span className="flex shrink-0 items-center gap-1 self-center rounded-full bg-accent/20 py-0.5 pr-0.5 pl-2.5 text-xs font-normal text-accent tabular-nums">
                {selectedCount} 件を選択中
                <span className="text-accent/60">/ {count}</span>
                <button
                  title="選択を解除（Esc）"
                  onClick={() => setSelection([])}
                  className="rounded-full p-0.5 hover:bg-accent/25"
                >
                  <X size={12} />
                </button>
              </span>
            ) : (
              <span
                className={`shrink-0 text-xs font-normal tabular-nums ${total !== null ? "text-accent" : "text-dim"}`}
                title={total !== null ? `絞り込み中（条件 ${conditions} 個）` : undefined}
              >
                {total !== null ? `${count} / ${total} 件` : `${count} 件`}
              </span>
            )}
          </h1>
          <div className="flex-1" />
          <ThemeToggle className="hidden @max-xl:flex" />
          <InspectorToggle className="hidden @max-xl:flex" />
        </div>
        <div className="flex flex-1 items-center justify-end gap-2">
          <label
            title={SEARCH_HELP}
            className="flex h-8 min-w-28 shrink basis-60 items-center gap-2 rounded-md border border-transparent bg-ink/7 px-2 focus-within:border-accent @max-xl:min-w-0 @max-xl:flex-1"
          >
            <Search size={14} className="shrink-0 text-dim" />
            <input
              id="search"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && !composing(e) && (setText(""), e.currentTarget.blur())}
              placeholder="検索（-除外 / OR）"
              className="w-0 min-w-0 flex-1 bg-transparent outline-none placeholder:text-dim"
            />
            {/* Hidden while empty, its room kept (docs/UI.md). */}
            <button onClick={() => setText("")} className={`text-dim hover:text-fg ${text ? "" : "invisible"}`}>
              <X size={14} />
            </button>
          </label>
          <ThemeToggle className="flex @max-xl:hidden" />
          <InspectorToggle className="flex @max-xl:hidden" />
        </div>
      </div>
      {/* The text row stays whatever the layout (docs/UI.md). */}
      <SpecimenControls />
      {/* One band for the conditions, this view's own controls and how the list
          looks (docs/NAVIGATION.md). It folds a step at a time as the toolbar
          narrows instead of growing a row (docs/UI.md). */}
      <FilterRow viewControls={<ViewControls />} display={<DisplayControls />} />
    </header>
  );
}

/**
 * Everything that belongs to the open view alone — what narrows it, what
 * describes it, and its one action (docs/UI.md「この表示の操作」). Right of
 * the conditions, so the first condition sits in the same place whatever view
 * is open; the action stays put while the rest scrolls when room runs short.
 *
 * Adding isn't here: things are dropped onto the window, or added from the
 * ファイル menu (docs/MENUS.md).
 */
function ViewControls() {
  const view = useStore((s) => s.view);
  const showSubfolders = useStore((s) => s.showSubfolders);
  const setShowSubfolders = useStore((s) => s.setShowSubfolders);
  const [reloading, setReloading] = useState(false);

  if (view.kind === "folder")
    return (
      <label
        className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-dim hover:text-fg"
        title="このフォルダのサブフォルダに入っているものも一覧に出す"
      >
        <input
          type="checkbox"
          checked={showSubfolders}
          onChange={(e) => setShowSubfolders(e.target.checked)}
          className="accent-accent"
        />
        サブフォルダ<span className="@max-5xl:hidden">の内容も表示</span>
      </label>
    );

  if (view.kind === "trash")
    return (
      <button
        title="ゴミ箱を空にする"
        onClick={emptyTrash}
        className={`${viewAction} border border-danger/60 text-danger hover:bg-danger/10`}
      >
        <Trash2 size={14} /> <span className="@max-5xl:hidden">ゴミ箱を空にする</span>
      </button>
    );

  // Fonts installed or removed since they were read (docs/SYSTEM_FONTS.md).
  if (view.kind === "system")
    return (
      <button
        title="フォントのフォルダを読み直して、インストール・削除したフォントを反映"
        disabled={reloading}
        onClick={() => {
          setReloading(true);
          void reloadSystemFonts().finally(() => setReloading(false));
        }}
        className={`${viewAction} ghost disabled:off`}
      >
        <RefreshCw size={14} className={reloading ? "animate-spin" : ""} />
        <span className="@max-5xl:hidden">読み込み直す</span>
      </button>
    );

  return null;
}

/** The open view's one action, in the same place on the band whatever it is. */
const viewAction = "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 whitespace-nowrap @max-5xl:px-2";

/**
 * How the list looks, at the right end of the band. As the toolbar narrows
 * these fold in reverse order of how often they are used, each staying in its
 * own place: レイアウト into the display menu first, the order down to its
 * icon, and the grouping last of all (docs/UI.md). The sizes are on the
 * specimen text row.
 */
function DisplayControls() {
  const sort = useStore((s) => s.sort);
  const desc = useStore((s) => s.desc);
  const setSort = useStore((s) => s.setSort);
  const view = useStore((s) => s.view);
  const isSystem = view.kind === "system";
  const canManual = view.kind === "folder";
  const manual = sort === "manual";
  const sortLabel = manual ? "手動" : (SORTS.find((s) => s.key === sort)?.label ?? "");
  return (
    <>
      {/* The order and its direction side by side, quiet until hovered. */}
      <div className="flex h-7 shrink-0 items-stretch gap-0.5">
        {/* Native select laid over a label sized to the current choice, so long
            names aren't clipped and the arrow matches the UI. The wrapper holds a
            width for the longest one, so picking another doesn't push what is
            to its right (docs/UI.md); the label sits at its right end, next to
            the direction, so a short one doesn't leave a gap before it. */}
        <div className="flex min-w-[7.75rem] justify-end @max-4xl:min-w-0">
          <label
            title={`並び順：${sortLabel}`}
            className="relative flex items-center gap-1.5 rounded-md pr-2 pl-2.5 whitespace-nowrap hover:bg-hover focus-within:ring-2 focus-within:ring-accent @max-4xl:px-2"
          >
            <ArrowUpDown size={14} className="hidden text-dim @max-4xl:block" />
            <span className="@max-4xl:hidden">{sortLabel}</span>
            <ChevronDown size={14} className="text-dim" />
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
        </div>
        <button
          title={manual ? "手動の並びは昇順のみ" : desc ? "降順" : "昇順"}
          disabled={manual}
          onClick={() => setSort(sort, !desc)}
          className="flex w-7 items-center justify-center rounded-md enabled:hover:bg-hover enabled:active:bg-press disabled:off"
        >
          {desc ? <ArrowDownWideNarrow size={15} /> : <ArrowUpNarrowWide size={15} />}
        </button>
      </div>
      <GroupMenu />
      <Divider className="@max-5xl:hidden" />
      <LayoutSwitch />
      <DisplayMenu />
    </>
  );
}

/** Appearance in one click (docs/UI.md「色」): システム → ライト → ダーク. The icon is the current choice. */
function ThemeToggle({ className }: { className: string }) {
  const current = parseAppearance(useStore((s) => s.appSettings?.appearance));
  const next = nextAppearance(current);
  return (
    <button
      title={`外観：${appearanceLabel(current)}（クリックで「${appearanceLabel(next)}」。⌘/Ctrl+Shift+D）`}
      aria-label={`外観を${appearanceLabel(next)}にする`}
      onClick={() => command("view.appearance").run(useStore.getState())}
      className={`h-8 w-8 shrink-0 items-center justify-center rounded-md ghost ${className}`}
    >
      {current === "system" ? <Monitor size={15} /> : current === "light" ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  );
}

/** Rendered twice (end of the row, or top-right when the toolbar is stacked). */
function InspectorToggle({ className }: { className: string }) {
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const toggleInspector = useStore((s) => s.toggleInspector);
  return (
    <button
      title={`詳細パネルを${inspectorOpen ? "閉じる" : "開く"}（⌘/Ctrl+I）`}
      onClick={toggleInspector}
      className={`h-8 w-8 shrink-0 items-center justify-center rounded-md ghost ${className} ${
        inspectorOpen ? "" : "text-accent"
      }`}
    >
      {inspectorOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
    </button>
  );
}
