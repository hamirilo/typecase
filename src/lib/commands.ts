/**
 * Every operation of the app, defined once (docs/MENUS.md §1). The menu bar,
 * the right-click menus, the list's keyboard handling and the shortcut list
 * (?) are all made from this table, so a name and its key read the same
 * everywhere.
 *
 * Keys are written like "Mod+Shift+R": Mod is ⌘ on macOS and Ctrl elsewhere.
 * The first key is the one menus show.
 */
import { Copy, FolderInput, Heart, Layers, Pin, Plus, Trash2, type LucideIcon } from "lucide-react";
import { otherTheme } from "./appearance";
import {
  copySelection,
  copyTags,
  createFolder,
  createFolderHere,
  createLibraryDialog,
  createSmartFolder,
  deleteSelection,
  exportLibrary,
  exportList,
  importFilesDialog,
  importFolderDialog,
  moveToLastFolder,
  onShelf,
  openLibraryDialog,
  openSelection,
  pasteTags,
  selectionOrShown,
  setRating,
  shiftFolder,
  toggleFavorite,
  togglePinned,
  toggleTray,
  transferAll,
  transferList,
  trayList,
} from "./actions";
import { api, isSystemId, type Item } from "./api";
import { fontApi } from "../features/fonts/api";
import { checkForUpdate, openReleaseNotes } from "./update";
import { currentFolderId, shelfShown, useStore } from "../store";
import { rowIds } from "./grouping";
import { useShortcutHelp } from "../components/ShortcutHelp";

type S = ReturnType<typeof useStore.getState>;

export interface Command {
  id: string;
  /** Name in the shortcut list and the default label. */
  title: string;
  /** The label for the current state ("お気に入りに追加" / "お気に入りから外す"). */
  label?: (s: S) => string;
  icon?: LucideIcon;
  keys?: string[];
  enabled?: (s: S) => boolean;
  checked?: (s: S) => boolean;
  run: (s: S) => void;
  /**
   * Who handles the key: "grid" (the list's key handler, the default),
   * "global" (its own handler, e.g. ⌘, and ?) or
   * "menu" (only the menu bar's accelerator).
   */
  keyBy?: "grid" | "global" | "menu";
}

const sel = (s: S) => [...s.selected];
/** A text field has the focus (keys there are for typing). */
const typing = () => !!(document.activeElement as HTMLElement | null)?.closest?.("input, textarea, [contenteditable]");
const any = (s: S) => s.selected.size > 0;
const notTrash = (s: S) => s.view.kind !== "trash";
/**
 * Something selected, and all of it library items: the fonts installed on this
 * computer can be looked at but not changed, copied or taken out (docs/SYSTEM_FONTS.md).
 */
const mine = (s: S) => any(s) && !sel(s).some(isSystemId);
/** The list is the library's (not the installed fonts). */
const library = (s: S) => s.view.kind !== "system";
const live = (s: S) => mine(s) && notTrash(s);
const selItems = (s: S): Item[] => {
  const byId = new Map(s.rawItems.map((i) => [i.id, i]));
  return sel(s).flatMap((id) => byId.get(id) ?? []);
};
const allHave = (s: S, f: (i: Item) => boolean) => {
  const xs = selItems(s);
  return xs.length > 0 && xs.every(f);
};
const lastFolder = (s: S) => s.folders.find((f) => f.id === s.recentFolders[0]);

/**
 * ⌘+ / ⌘-: the size set on the specimen text row: the text in the specimen
 * layout, the tiles in the grid.
 */
function zoom(s: S, dir: 1 | -1) {
  if (s.layout === "specimen") s.setSpecimenSize(s.specimenSize + 8 * dir);
  else s.setTileSize(s.tileSize + 20 * dir);
}

const ALL_COMMANDS: Command[] = [
  // ---------------------------------------------------------------- app
  {
    id: "app.settings",
    title: "設定…",
    keys: ["Mod+,"],
    keyBy: "global",
    run: (s) => s.openSettings("last"),
  },
  { id: "app.checkUpdate", title: "アップデートを確認…", run: () => checkForUpdate(true) },
  // Windows' ヘルプ menu (macOS has the system's about panel in the app menu):
  // the settings' アップデート section shows the app, its version and updates.
  { id: "help.about", title: "Typecase について", run: (s) => s.openSettings("general") },
  { id: "help.releaseNotes", title: "このバージョンの更新内容", run: () => openReleaseNotes() },
  {
    id: "help.shortcuts",
    title: "キーボードショートカット",
    keys: ["?"],
    keyBy: "global",
    run: () => useShortcutHelp.getState().setOpen(true),
  },
  { id: "help.log", title: "ログを表示", run: (s) => s.run(() => api.revealLog()) },

  // ------------------------------------------------------------ library
  // Adding is mostly done by dropping onto the window; these are the menu's way in.
  {
    id: "list.import",
    title: "フォントを追加…",
    icon: Plus,
    enabled: library,
    run: () => void importFilesDialog(),
  },
  {
    id: "list.importFolder",
    title: "フォルダから追加…",
    icon: FolderInput,
    enabled: library,
    run: () => void importFolderDialog(),
  },
  { id: "library.new", title: "新しいライブラリ…", run: () => void createLibraryDialog() },
  { id: "library.open", title: "ライブラリを開く…", run: () => void openLibraryDialog() },
  {
    id: "library.transferAll",
    title: "すべてを別のライブラリへ…",
    enabled: (s) => s.counts.all > 0,
    run: () => transferAll(),
  },

  // --------------------------------------------------------------- view
  {
    id: "view.appearance",
    // Quick switch between light and dark (the toolbar button too); "system" is chosen in settings.
    title: "ライト／ダークを切り替え",
    label: () => (otherTheme() === "light" ? "ライトにする" : "ダークにする"),
    keys: ["Mod+Shift+D"],
    run: (s) => s.saveAppSettings({ appearance: otherTheme() }),
  },
  {
    id: "view.sidebar",
    title: "サイドバー",
    keys: ["Tab", "Mod+Alt+1"],
    checked: (s) => s.sidebarOpen,
    run: (s) => s.toggleSidebar(),
  },
  {
    id: "view.inspector",
    // The details panel's information tab: from the shelf it switches, shown it closes (docs/UI.md).
    title: "情報",
    keys: ["Mod+I", "Mod+Alt+2"],
    checked: (s) => s.inspectorOpen && s.panelTab === "info",
    run: (s) => s.togglePanelTab("info"),
  },
  {
    id: "view.shelf",
    title: "シェルフ",
    // The details panel's other tab, the same way as "情報".
    keys: ["Mod+Alt+3"],
    checked: (s) => shelfShown(s),
    run: (s) => s.togglePanelTab("shelf"),
  },
  {
    id: "view.toc",
    title: "グループの目次",
    keys: ["Mod+Alt+J"],
    // Only where the list is in sections (docs/UI.md: greyed out, not removed).
    enabled: (s) => s.sections.length > 0,
    checked: (s) => s.tocOpen,
    run: (s) => s.setTocOpen(!s.tocOpen),
  },
  {
    id: "view.zoomIn",
    title: "拡大",
    label: (s) => (s.layout === "specimen" ? "文字を大きく" : "拡大"),
    keys: ["Mod+="],
    run: (s) => zoom(s, 1),
  },
  {
    id: "view.zoomOut",
    title: "縮小",
    label: (s) => (s.layout === "specimen" ? "文字を小さく" : "縮小"),
    keys: ["Mod+-"],
    run: (s) => zoom(s, -1),
  },
  {
    id: "view.subfolders",
    title: "サブフォルダの内容を表示",
    checked: (s) => s.showSubfolders,
    run: (s) => s.setShowSubfolders(!s.showSubfolders),
  },
  { id: "go.folder", title: "フォルダへ…", keys: ["Mod+J"], run: (s) => s.setPicker("goto") },

  // --------------------------------------------------------------- edit
  {
    id: "edit.search",
    title: "検索",
    keys: ["Mod+F"],
    run: () => document.getElementById("search")?.focus(),
  },
  {
    id: "edit.filter",
    title: "絞り込みへ",
    keys: ["Mod+Shift+F"],
    // The filter row is always there: the key takes the focus to its first condition.
    run: () => document.querySelector<HTMLElement>("[data-filter-row] button:not(:disabled)")?.focus(),
  },
  {
    id: "edit.selectAll",
    title: "すべてを選択",
    keys: ["Mod+A"],
    run: (s) => s.setSelection(rowIds(s.items)),
  },
  { id: "edit.deselect", title: "選択を解除", keys: ["Esc"], enabled: any, run: (s) => s.setSelection([]) },
  {
    id: "item.copy",
    title: "コピー",
    icon: Copy,
    keys: ["Mod+C"],
    enabled: mine,
    run: (s) => void copySelection(sel(s)),
  },
  {
    id: "item.copyTags",
    title: "タグをコピー",
    keys: ["Mod+Shift+C"],
    enabled: mine,
    run: (s) => void copyTags(sel(s)),
  },
  {
    id: "item.pasteTags",
    title: "タグを貼り付け",
    keys: ["Mod+Shift+V"],
    enabled: live,
    run: (s) => void pasteTags(sel(s)),
  },
  {
    id: "item.rename",
    title: "名前を変更",
    keys: ["F2", "Mod+R"],
    // Nothing selected in a folder: the folder's own name.
    enabled: (s) => (s.selected.size === 1 && mine(s)) || (s.selected.size === 0 && s.view.kind === "folder"),
    run: (s) => {
      if (s.selected.size === 1) s.requestItemRename();
      else if (s.view.kind === "folder") s.setRenamingFolder(s.view.id);
    },
  },
  {
    id: "item.trash",
    title: "ゴミ箱へ移動",
    label: (s) => (s.view.kind === "trash" ? "完全に削除" : "ゴミ箱へ移動"),
    icon: Trash2,
    keys: ["Mod+Backspace", "Delete"],
    // ⌘⌫ / Ctrl+Backspace reach the menu while typing too: in a text field
    // (the search box, the specimen text) they are for deleting words.
    enabled: (s) => mine(s) && !typing(),
    run: (s) => void deleteSelection(sel(s)),
  },

  // --------------------------------------------------------------- item
  {
    id: "item.show",
    title: "表示",
    keys: ["Space", "Enter"],
    // The list opens the focused item itself (Grid.tsx); this is for menus.
    keyBy: "menu",
    enabled: any,
    run: (s) => {
      const i = s.items.findIndex((x) => x.id === (s.focus && s.selected.has(s.focus) ? s.focus : sel(s)[0]));
      if (i >= 0) s.openViewer(i);
    },
  },
  { id: "item.open", title: "既定のアプリで開く", enabled: mine, run: (s) => void openSelection(sel(s)) },
  {
    id: "item.reveal",
    title: "Finder / エクスプローラで表示",
    enabled: (s) => s.selected.size === 1,
    // An installed font: its file in the OS's font folder.
    run: (s) => {
      const id = sel(s)[0];
      void s.run(() => (isSystemId(id) ? fontApi.revealSystem(id) : api.revealItem(id)));
    },
  },
  {
    id: "item.favorite",
    title: "お気に入り",
    label: (s) => (allHave(s, (i) => i.favorite) ? "お気に入りから外す" : "お気に入りに追加"),
    icon: Heart,
    keys: ["F"],
    enabled: live,
    checked: (s) => allHave(s, (i) => i.favorite),
    run: (s) => void toggleFavorite(sel(s)),
  },
  {
    id: "item.pin",
    title: "ピン留め",
    label: (s) => (allHave(s, (i) => i.pinnedAt !== null) ? "ピン留めを解除" : "ピン留め"),
    icon: Pin,
    keys: ["P"],
    enabled: live,
    checked: (s) => allHave(s, (i) => i.pinnedAt !== null),
    run: (s) => void togglePinned(sel(s)),
  },
  {
    id: "item.tray",
    title: "シェルフ",
    // A selected family goes on the shelf as one font (`shelfIds`).
    label: (s) => (sel(s).length && onShelf(sel(s)) ? "シェルフから外す" : "シェルフに追加"),
    icon: Layers,
    keys: ["B"],
    // Installed fonts go on the shelf too, to be compared (docs/SYSTEM_FONTS.md).
    enabled: (s) => any(s) && notTrash(s),
    checked: (s) => sel(s).length > 0 && onShelf(sel(s)),
    run: (s) => void toggleTray(sel(s)),
  },
  ...[0, 1, 2, 3, 4, 5].map(
    (n): Command => ({
      id: `item.rate${n}`,
      title: n ? "★".repeat(n) : "評価なし",
      // The list handles the digits itself (Shift+digit also moves on).
      keys: [String(n)],
      keyBy: "menu",
      enabled: live,
      checked: (s) => allHave(s, (i) => i.rating === n),
      run: (s) => void setRating(sel(s), n),
    }),
  ),
  // ---------------------------------------------------- taking things out
  {
    id: "list.export",
    title: "書き出し…",
    keys: ["Mod+E"],
    enabled: library,
    run: () => exportList(selectionOrShown()),
  },
  {
    id: "library.export",
    title: "ライブラリ全体を書き出し…",
    // Every item not in the trash, whatever the list shows (docs/EXPORT.md).
    enabled: (s) => !!s.library && s.counts.all > 0,
    run: () => exportLibrary(),
  },
  {
    id: "list.transfer",
    title: "別のライブラリへ…",
    icon: FolderInput,
    enabled: library,
    run: () => void transferList(selectionOrShown()),
  },
  {
    id: "list.tray",
    title: "シェルフにすべて追加",
    enabled: library,
    run: () => void trayList({ kind: "shown" }),
  },

  // -------------------------------------------------------------- organize
  {
    id: "item.moveTo",
    title: "フォルダへ移動…",
    keys: ["Mod+Shift+J"],
    enabled: live,
    run: (s) => s.setPicker("move"),
  },
  {
    id: "item.moveToLast",
    title: "最後に使ったフォルダへ移動",
    label: (s) => (lastFolder(s) ? `「${lastFolder(s)!.name}」へ移動` : "最後に使ったフォルダへ移動"),
    keys: ["Shift+D"],
    enabled: live,
    run: (s) => void moveToLastFolder(sel(s)),
  },
  {
    id: "item.newFolder",
    title: "選択から新しいフォルダ",
    enabled: live,
    run: (s) => void createFolder(null, sel(s)),
  },
  {
    id: "item.unfile",
    title: "未分類に戻す",
    enabled: (s) => mine(s) && s.view.kind === "folder",
    run: (s) => {
      const folder = currentFolderId();
      if (folder) void s.run(() => api.removeFromFolder(sel(s), folder));
    },
  },
  { id: "folder.new", title: "新しいフォルダ", keys: ["Mod+Shift+N"], run: () => void createFolderHere() },
  {
    id: "tag.new",
    title: "新しいタグ",
    // The sidebar's ＋ on 「タグ」: a row to type the name in (the tags section opens if folded).
    enabled: library,
    run: (s) => s.setCreatingTag(true),
  },
  {
    id: "smart.new",
    title: "新しいスマートフォルダ",
    keys: ["Mod+Shift+Alt+N"],
    // It saves the conditions on screen, which are of the installed fonts there.
    enabled: library,
    run: () => void createSmartFolder(),
  },
  ...(
    [
      ["folder.up", "フォルダを上へ", "Mod+[", -1, false],
      ["folder.down", "フォルダを下へ", "Mod+]", 1, false],
      ["folder.top", "フォルダを先頭へ", "Mod+Shift+[", -1, true],
      ["folder.bottom", "フォルダを末尾へ", "Mod+Shift+]", 1, true],
    ] as const
  ).map(
    ([id, title, key, by, toEnd]): Command => ({
      id,
      title,
      keys: [key],
      enabled: (s) => s.view.kind === "folder",
      run: (s) => s.view.kind === "folder" && void shiftFolder(s.view.id, by, toEnd),
    }),
  ),
];

export const COMMANDS: Command[] = ALL_COMMANDS;

const byId = new Map(COMMANDS.map((c) => [c.id, c]));

export function command(id: string): Command {
  const c = byId.get(id);
  if (!c) throw new Error(`unknown command ${id}`);
  return c;
}

export const isEnabled = (c: Command, s: S) => c.enabled?.(s) ?? true;

export const labelOf = (c: Command, s: S) => c.label?.(s) ?? c.title;

/**
 * The last command run and from where. A key can reach both the menu bar's
 * accelerator and the list's handler (which one depends on the platform),
 * so the second of the two within a moment is dropped.
 */
let lastRun = { id: "", by: "", at: 0 };

function runFrom(c: Command, s: S, by: "key" | "menu") {
  const now = performance.now();
  if (lastRun.id === c.id && lastRun.by !== by && now - lastRun.at < 250) return;
  lastRun = { id: c.id, by, at: now };
  c.run(s);
}

/** Runs a command by id if it is enabled now (menu bar items). */
export function runCommand(id: string) {
  const c = command(id);
  const s = useStore.getState();
  if (isEnabled(c, s)) runFrom(c, s, "menu");
}

// ---------------------------------------------------------------- keys

/** The key part of a combo matched against an event (layout-independent where it can be). */
function keyMatches(key: string, e: KeyboardEvent): boolean {
  if (/^[A-Z]$/.test(key)) return e.code === `Key${key}`;
  if (/^[0-9]$/.test(key)) return e.code === `Digit${key}` || e.code === `Numpad${key}`;
  switch (key) {
    case "[":
      return e.code === "BracketLeft";
    case "]":
      return e.code === "BracketRight";
    // ⌘+: "=" on US keyboards (with or without Shift), ";" on JIS.
    case "=":
      return e.key === "=" || e.key === "+" || e.key === ";";
    case "-":
      return e.key === "-";
    case "/":
      return e.code === "Slash";
    case "Esc":
      return e.key === "Escape";
    case "Space":
      return e.key === " ";
    default:
      return e.key === key;
  }
}

/** Whether `e` is exactly `combo` (no extra modifiers; Shift is free for "="). */
export function comboMatches(combo: string, e: KeyboardEvent): boolean {
  const parts = combo.split("+");
  // "Mod+=" splits into ["Mod", "="]; a bare "+" never appears.
  const key = parts.pop()!;
  const mods = new Set(parts);
  if ((e.metaKey || e.ctrlKey) !== mods.has("Mod")) return false;
  if (e.altKey !== mods.has("Alt")) return false;
  if (key !== "=" && e.shiftKey !== mods.has("Shift")) return false;
  return keyMatches(key, e);
}

/**
 * The list's key handler: runs the command bound to `e`, if any is enabled.
 * Returns whether it took the key.
 */
export function runKey(e: KeyboardEvent): boolean {
  const s = useStore.getState();
  for (const c of COMMANDS) {
    if ((c.keyBy ?? "grid") !== "grid" || !c.keys?.some((k) => comboMatches(k, e))) continue;
    e.preventDefault();
    if (c.enabled?.(s) ?? true) runFrom(c, s, "key");
    return true;
  }
  return false;
}
