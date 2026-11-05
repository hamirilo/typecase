import { create } from "zustand";
import {
  api,
  EMPTY_FILTER,
  type AppSettings,
  type Counts,
  type Filter,
  type Folder,
  type Rule,
  type SmartFolder,
  type ImportSummary,
  type Item,
  type ItemQuery,
  type LibraryInfo,
  type SortKey,
  type Tag,
  type View,
} from "./lib/api";
import { fontApi } from "./features/fonts/api";
import { fontShelf, querySystemFonts, refreshFontLinks, systemFonts } from "./features/fonts/system";
import {
  DEFAULT_LIBRARY_SETTINGS,
  parseLibrarySettings,
  parseSidebarHidden,
  SIDEBAR_ENTRIES,
  type LibrarySettings,
  type SidebarHidden,
} from "./lib/librarySettings";
import { groupItems, rowIds, type GroupBy, type Section } from "./lib/grouping";
import { warn } from "./lib/log";
import { MAX_OWN_PATTERNS } from "./features/fonts/patterns";
import { notifyIfAway } from "./lib/osNotify";

/** x/y = current pointer, sx/sy = where the drag started (for snap-back). */
type DragPos = { x: number; y: number; sx: number; sy: number };
export type Drag =
  /** `from`: picked up on the shelf (reordered there, not added again). */
  | ({ kind: "items"; ids: string[]; from?: "shelf" } & DragPos)
  /** `ids`: the folders picked in the sidebar, in its order. */
  | ({ kind: "folder"; ids: string[] } & DragPos);

export interface ToastAction {
  label: string;
  onClick: () => void;
}

/** The specimen (each font's sample text, docs/FONT_UI.md) or a grid of tiles. */
export type Layout = "specimen" | "grid";

/** The layouts, the first being the default. No list: the specimen with small text does its job. */
export const LAYOUTS: Layout[] = ["specimen", "grid"];

/** The groupings. Fonts are always one row per family (▸ opens its styles), so no family grouping. */
export const GROUPS: GroupBy[] = ["none", "category", "script", "month", "rating", "tag", "folder"];

/** What the grid shows under each tile. */
export interface ShowInfo {
  name: boolean;
  rating: boolean;
  /** File type and size. */
  meta: boolean;
}

export type ToastKind = "success" | "info" | "error";

export interface ToastOptions {
  title: string;
  /** A second, quieter line (counts, reasons). */
  detail?: string;
  kind?: ToastKind;
  action?: ToastAction;
  /**
   * ms before it goes away, 0 = until closed; paused while hovered or focused
   * and while the window can't be seen. Left out: by kind and length (`toastDuration`).
   */
  duration?: number;
  /** Rewrite this toast in place (a result following its "…しています"), if it is still showing. */
  replace?: number;
}

export interface Toast extends Required<Pick<ToastOptions, "title" | "kind" | "duration">> {
  id: number;
  /** Bumped when the toast is rewritten in place; restarts its countdown. */
  rev: number;
  detail?: string;
  action?: ToastAction;
  leaving?: boolean;
}

export type TransferRequest =
  /** Selected items. */
  | { ids: string[]; count: number }
  /** Every item not in the trash. */
  | { ids: null; count: number };

/**
 * What a "the contents of this list" action works on: given items, the list
 * on screen, a folder / smart folder / tag from the sidebar, or the shelf.
 */
export type ListSource =
  | { kind: "ids"; ids: string[] }
  | { kind: "shown" }
  | { kind: "folder"; id: string }
  | { kind: "smart"; id: string }
  | { kind: "tag"; id: number }
  | { kind: "tray" };

/** The export dialog: what to write and its title ("「和文」を書き出し"); the whole library (docs/EXPORT.md). */
export interface ExportRequest {
  source: ListSource | { kind: "library" };
  title: string;
}

/**
 * The settings screen's pages: the app's (一般, サイドバー), then the open
 * library's (概要, サイドバー). See docs/SETTINGS.md.
 */
export type SettingsTab = "general" | "sidebar" | "library" | "librarySidebar";

/** Where sidebar entries are hidden: the app's settings or the open library's. */
export type SidebarScope = "app" | "library";

/** A long task shown with a progress bar (bottom right). */
export interface Progress {
  label: string;
  done: number;
  total: number;
  /** Shows a キャンセル button. */
  cancel?: () => void;
}

interface State {
  library: LibraryInfo | null;
  /** The open library's own settings (docs/SETTINGS.md). */
  librarySettings: LibrarySettings;
  /** The app's settings (settings.json); null until read at launch. */
  appSettings: AppSettings | null;

  view: View;
  search: string;
  tagFilter: number[];
  /** Sidebar tag filter requires all selected tags (AND) instead of any (OR). */
  tagMatchAll: boolean;
  sort: SortKey;
  desc: boolean;
  thumbSize: number;
  /** Font specimen layout: the text every font shows ("" = each font's own sample) and its size in px. */
  specimenText: string;
  specimenSize: number;
  /** Font grid: the size of a tile (px), set on the specimen text row in place of the thumbnail size. */
  tileSize: number;
  /** Families whose styles are listed under their row (▸), for the session. */
  openFamilies: ReadonlySet<string>;
  /** Fonts lacking most of `specimenText` show their own sample instead (an English font with Japanese text). */
  specimenFallback: boolean;
  inspectorOpen: boolean;
  sidebarOpen: boolean;
  /** The list's table of contents (the sections to jump to) is open. Not kept: it closes on its own. */
  tocOpen: boolean;
  /** Widths of the sidebar and the details panel (px), dragged at their edge. */
  sidebarWidth: number;
  inspectorWidth: number;
  /** Folder views include items from subfolders. */
  showSubfolders: boolean;
  minRating: number;
  /** Attribute filters from the filter row. */
  filter: Filter;
  /** The smart folder whose conditions the row is editing. */
  editingSmart: { id: string; name: string } | null;
  layout: Layout;
  showInfo: ShowInfo;
  /** How the list is split into sections. */
  groupBy: GroupBy;
  /** Viewer: details panel and the strip of thumbnails. */
  viewerInfo: boolean;
  viewerStrip: boolean;
  /** Viewer: the font alone, with the bar, arrows, details and strip hidden (H). */
  viewerBare: boolean;
  /** Tag names copied with ⌘⇧C. */
  tagClipboard: string[];
  /** Most recently used target folders (for Shift+D and the picker). */
  recentFolders: string[];
  /** Most recently assigned tags, newest first (suggested in the tag input). */
  recentTags: number[];
  /** Folder whose name is being edited inline in the sidebar. */
  renamingFolder: string | null;
  /** The sidebar's new-tag row is open (the tag's name is being typed). */
  creatingTag: boolean;
  /** Bumped to ask the inspector to focus the item name field. */
  renameItemSeq: number;
  picker: "move" | "goto" | null;
  /** The settings screen (⌘,) is open, on this page. */
  settingsTab: SettingsTab | null;
  /** The page the settings showed last; "last" opens it again (UI §9). */
  lastSettingsTab: SettingsTab;
  /** The "別のライブラリへ" dialog: selected items, or every item. */
  transfer: TransferRequest | null;
  /** The export dialog (書き出し…). */
  exporting: ExportRequest | null;

  /** What the grid shows: the query result, regrouped by `groupBy`. */
  items: Item[];
  /** The query result as returned (one entry per font). */
  rawItems: Item[];
  /** What is on the shelf (the `tray` table, and the installed fonts on it), in its own order. */
  shelf: Item[];
  /** What the details panel on the right shows: the selection's information or the shelf; changed only by the user. */
  panelTab: PanelTab;
  /** The comparison of the shelf is shown in place of the list. */
  comparing: boolean;
  /** Bands of `items`: the `groupBy` sections. */
  sections: Section[];
  folders: Folder[];
  smartFolders: SmartFolder[];
  /** File types in the library with counts (filter row options). */
  exts: [string, number][];
  tags: Tag[];
  counts: Counts;
  /** Bumped after every refresh so dependents (inspector) can re-fetch. */
  rev: number;
  /** Font files installed on this computer (docs/SYSTEM_FONTS.md); null until first listed. */
  systemCount: number | null;

  selected: Set<string>;
  /** Start of a shift-range. */
  anchor: string | null;
  /** Last item clicked / moved to with the keyboard. */
  focus: string | null;
  viewer: number | null;

  drag: Drag | null;
  /** Files from Finder / Explorer are being dragged over the window. */
  fileDrag: boolean;
  dropTarget: string | null; // "folder:<id>" or "root"
  /** Sidebar row that just received a drop; `n` restarts the animation. */
  flash: { target: string; n: number } | null;
  importing: Progress | null;
  /** Update download in progress (bytes; total is null when the server did not say). */
  updating: { done: number; total: number | null; installing?: boolean } | null;
  toasts: Toast[];

  setLibrary: (lib: LibraryInfo | null) => Promise<void>;
  /** Hides (or shows again) sidebar entries, in `scope` (default: the one in effect). */
  setSidebarHidden: (ids: string[], scope?: SidebarScope) => void;
  /** The library gets its own sidebar entries, or follows the app's again. */
  setSidebarOwn: (own: boolean) => void;
  loadAppSettings: () => Promise<void>;
  /** Changes and saves the app's settings (once read). */
  saveAppSettings: (patch: Partial<AppSettings>) => void;
  setView: (view: View) => void;
  setSearch: (s: string) => void;
  toggleTagFilter: (id: number) => void;
  clearTagFilter: () => void;
  setTagMatchAll: (on: boolean) => void;
  setSort: (sort: SortKey, desc: boolean) => void;
  setThumbSize: (n: number) => void;
  setSpecimenText: (text: string) => void;
  setSpecimenSize: (px: number) => void;
  setTileSize: (px: number) => void;
  /** Saves the typed specimen text as the library's own pattern / forgets one. */
  saveSpecimenPattern: (text: string) => void;
  removeSpecimenPattern: (text: string) => void;
  /** Opens or closes a family's styles under its row (specimen layout). */
  toggleFamily: (family: string) => void;
  setSpecimenFallback: (on: boolean) => void;
  toggleInspector: () => void;
  setPanelTab: (tab: PanelTab) => void;
  /**
   * ⌘I / ⌘⌥3: shows `tab` in the details panel (opening it, or switching from
   * the other tab); closes the panel when `tab` is already shown.
   */
  togglePanelTab: (tab: PanelTab) => void;
  setComparing: (on: boolean) => void;
  toggleSidebar: () => void;
  setTocOpen: (open: boolean) => void;
  /** Sets a panel's width (kept within its limits, see PANEL_WIDTH). */
  setPanelWidth: (panel: "sidebar" | "inspector", px: number) => void;
  setShowSubfolders: (on: boolean) => void;
  setMinRating: (n: number) => void;
  setFilter: (patch: Partial<Filter>) => void;
  /** Resets every condition of the filter row and the search. */
  clearConditions: () => void;
  /** The ad-hoc conditions as a smart folder rule. */
  currentRule: () => Rule;
  /** Loads a smart folder's rule into the filters so it can be edited. */
  startEditSmart: (sf: SmartFolder) => void;
  stopEditSmart: () => void;
  setLayout: (l: Layout) => void;
  setShowInfo: (patch: Partial<ShowInfo>) => void;
  setGroupBy: (g: GroupBy) => void;
  toggleViewerInfo: () => void;
  toggleViewerStrip: () => void;
  toggleViewerBare: () => void;
  setTagClipboard: (names: string[]) => void;
  rememberFolders: (ids: string[]) => void;
  rememberTags: (names: string[]) => void;
  setRenamingFolder: (id: string | null) => void;
  setCreatingTag: (on: boolean) => void;
  requestItemRename: () => void;
  setPicker: (p: State["picker"]) => void;
  /** "last": the page shown last (一般 if it was the library's and none is open). */
  openSettings: (tab: SettingsTab | "last" | null) => void;
  setTransfer: (t: TransferRequest | null) => void;
  setExporting: (r: ExportRequest | null) => void;
  refresh: () => Promise<void>;

  /**
   * `at`: the item's display index. With tag grouping an item can appear
   * more than once, and a range runs between the places clicked.
   */
  select: (id: string, mode: "only" | "toggle" | "range", at?: number) => void;
  /** Selects exactly `ids` (a family row's fonts are expanded by the caller, see `rowIds`). */
  setSelection: (ids: string[]) => void;
  openViewer: (index: number | null) => void;

  setDrag: (d: Drag | null) => void;
  setDropTarget: (t: string | null) => void;
  setFileDrag: (on: boolean) => void;
  flashTarget: (target: string) => void;
  setImporting: (p: State["importing"]) => void;
  setUpdating: (p: State["updating"]) => void;
  toast: (message: string, error?: boolean, action?: ToastAction) => void;
  /** A toast with a title, detail line and kind (results worth noticing). Returns its id. */
  notify: (t: ToastOptions) => number;
  dismissToast: (id: number) => void;
  /**
   * Runs a mutation, reports errors, then refreshes. Resolves to whether it
   * worked: a result message must not follow the error toast.
   */
  run: (fn: () => Promise<unknown>) => Promise<boolean>;
  /** Reports an import; `since` (when it started) also tells the OS if it was long. */
  importDone: (s: ImportSummary, since?: number) => void;
}

// localStorage can throw (private mode etc.); treat it as best-effort.
const load = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const persist = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
};
const loadNumber = (key: string, fallback: number) => {
  const v = Number(load(key));
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** Default, smallest and largest width of the side panels. */
export const PANEL_WIDTH = {
  sidebar: { initial: 240, min: 190, max: 420 },
  inspector: { initial: 288, min: 240, max: 560 },
} as const;

const clampWidth = (panel: keyof typeof PANEL_WIDTH, px: number) =>
  Math.round(Math.min(PANEL_WIDTH[panel].max, Math.max(PANEL_WIDTH[panel].min, px)));

/** The details panel's tabs: the selection's information, or the shelf. */
export type PanelTab = "info" | "shelf";

/** The shelf is in view: the details panel is open on it. */
export const shelfShown = (s: { inspectorOpen: boolean; panelTab: PanelTab }) => s.inspectorOpen && s.panelTab === "shelf";

const loadJson = (key: string): object => {
  try {
    const v = JSON.parse(load(key) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};

/** Number of active ad-hoc conditions: the filter row's and the search. */
export function activeConditions(s: {
  search: string;
  tagFilter: number[];
  minRating: number;
  filter: Filter;
}): number {
  const f = s.filter;
  return (
    (s.search.trim() ? 1 : 0) +
    (s.tagFilter.length ? 1 : 0) +
    (s.minRating ? 1 : 0) +
    (f.fontScripts.length ? 1 : 0) +
    (f.fontCategories.length ? 1 : 0) +
    (f.fontWeights.length ? 1 : 0) +
    (f.fontFeatures.length ? 1 : 0) +
    (f.exts.length ? 1 : 0) +
    (f.importedAfter != null || f.importedBefore != null ? 1 : 0) +
    (f.minSize != null || f.maxSize != null ? 1 : 0)
  );
}

const recentTagsKey = (root: string) => `recentTags:${root}`;
const loadRecentTags = (root: string): number[] => {
  try {
    const v = JSON.parse(load(recentTagsKey(root)) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "number") : [];
  } catch {
    return [];
  }
};
let pendingRecentTags: string[] = [];

let refreshSeq = 0;
/**
 * How long a toast stays when not told: long enough to read it (a little more
 * for each character), longer with a button to press, and errors until closed
 * (docs/NOTIFICATIONS.md).
 */
export function toastDuration(kind: ToastKind, text: string, action: boolean): number {
  if (kind === "error") return 0;
  const read = 4000 + 80 * text.length;
  return Math.round(Math.min(12_000, Math.max(action ? 8000 : 5000, read)));
}

let toastSeq = 0;
let flashSeq = 0;
/** Display index of `anchor` when known (see `select`). */
let anchorAt: number | null = null;

/** Display index of item `id`: `at` when it is there, else its first place. */
function indexOf(items: Item[], id: string, at: number | null | undefined): number {
  return at != null && items[at]?.id === id ? at : items.findIndex((i) => i.id === id);
}

/** Ids the row at `at` stands for (a family row: all its fonts); `id` when it isn't there. */
function idsAt(items: Item[], id: string, at: number): string[] {
  const row = items[at];
  return row?.id === id ? rowIds([row]) : [id];
}

/** Most fonts on the font shelf: what the comparison can line up (docs/FONT_UI.md). */
export const FONT_SHELF_MAX = 8;

/** Smallest and largest font grid tile, and the default. */
export const TILE_SIZE = { min: 120, max: 320, initial: 180 } as const;

const NO_FAMILIES: ReadonlySet<string> = new Set();

/**
 * The display list and its sections for the current view / grouping: one
 * row per family; only the specimen layout opens them.
 */
function arrange(s: {
  layout: Layout;
  view: View;
  groupBy: GroupBy;
  openFamilies: ReadonlySet<string>;
  rawItems: Item[];
  tags: Tag[];
  folders: Folder[];
}): { items: Item[]; sections: Section[] } {
  const families = { open: s.layout === "specimen" ? s.openFamilies : NO_FAMILIES };
  return groupItems(s.rawItems, shownGroupBy(s), s.tags, s.folders, families);
}

/** Groupings by what only library items have (docs/SYSTEM_FONTS.md). */
export const LIBRARY_GROUPS: GroupBy[] = ["month", "rating", "tag", "folder"];

/** The grouping in effect: none for the installed fonts' list when it is by rating, tag or folder. */
export const shownGroupBy = (s: { view: View; groupBy: GroupBy }): GroupBy =>
  s.view.kind === "system" && LIBRARY_GROUPS.includes(s.groupBy) ? "none" : s.groupBy;

/** Re-arranges the list after a display change, keeping the viewer on the item it showed. */
function rearrange(s: State, patch: Partial<State>): Partial<State> {
  const next = { ...s, ...patch };
  const { items, sections } = arrange(next);
  const shown = s.viewer !== null ? s.items[s.viewer]?.id : undefined;
  const viewer = shown ? Math.max(0, items.findIndex((i) => i.id === shown)) : s.viewer;
  return { ...patch, items, sections, viewer };
}

const loadLayout = (): Layout => LAYOUTS.find((l) => l === load("layout")) ?? LAYOUTS[0];
// "year" was merged into "month" (年月).
const loadGroupBy = (): GroupBy => GROUPS.find((g) => g === (load("groupBy") === "year" ? "month" : load("groupBy"))) ?? "none";

/**
 * After the sidebar entries in effect changed: hiding what is open moves to
 * "すべて". The filter row's conditions stay (hiding is of places only).
 */
function leaveHidden() {
  const s = useStore.getState();
  const ids = sidebarHidden(s);
  const entry = entryOfView(s.view);
  if (entry && ids.includes(entry)) s.setView({ kind: "all" });
}

/** The conditions of the filter row, each cleared on its own (docs/NAVIGATION.md). */
export type ConditionKey =
  | "rating"
  | "tags"
  | "exts"
  | "date"
  | "size"
  | "fontScripts"
  | "fontCategories"
  | "fontWeights"
  | "fontFeatures";

/** What clearing each condition sets. */
export const CLEARED: Record<ConditionKey, { minRating?: 0; tagFilter?: number[]; filter?: Partial<Filter> }> = {
  rating: { minRating: 0 },
  tags: { tagFilter: [] },
  exts: { filter: { exts: [] } },
  date: { filter: { importedAfter: null, importedBefore: null } },
  size: { filter: { minSize: null, maxSize: null } },
  fontScripts: { filter: { fontScripts: [] } },
  fontCategories: { filter: { fontCategories: [] } },
  fontWeights: { filter: { fontWeights: [] } },
  fontFeatures: { filter: { fontFeatures: [] } },
};

type QueryState = Pick<
  State,
  "view" | "search" | "tagFilter" | "tagMatchAll" | "sort" | "desc" | "showSubfolders" | "minRating" | "filter"
>;

/**
 * The query of the list on screen; `without` leaves one condition out, for
 * the counts in its menu (with the other conditions on).
 */
export function listQuery(s: QueryState, without?: ConditionKey): ItemQuery {
  const c = without ? CLEARED[without] : {};
  const st = { ...s, ...c, filter: { ...s.filter, ...c.filter } };
  return {
    view: st.view,
    search: st.search,
    tagIds: st.tagFilter,
    tagMatchAll: st.tagMatchAll,
    includeSubfolders: st.showSubfolders,
    minRating: st.minRating,
    filter: st.filter,
    sort: st.sort,
    desc: st.desc,
  };
}

/**
 * How many items the open place has without any condition, for "5 / 13 件";
 * null where it isn't known.
 */
export function placeTotal(
  s: Pick<State, "view" | "counts" | "folders" | "tags" | "smartFolders" | "showSubfolders" | "systemCount">,
): number | null {
  const v = s.view;
  const n = (x: { count: number } | undefined) => x?.count ?? null;
  switch (v.kind) {
    case "all":
    case "unfiled":
    case "untagged":
    case "favorites":
    case "pinned":
    case "trash":
    case "tray":
      return s.counts[v.kind];
    case "tag":
      return n(s.tags.find((t) => t.id === v.id));
    case "fontScript":
      return s.counts.fontScripts[v.id] ?? 0;
    case "fontCategory":
      return s.counts.fontCategories[v.id] ?? 0;
    case "smart":
      return n(s.smartFolders.find((f) => f.id === v.id));
    case "folder": {
      const own = (id: string): number =>
        (n(s.folders.find((f) => f.id === id)) ?? 0) +
        (s.showSubfolders ? s.folders.filter((f) => f.parentId === id).reduce((n, f) => n + own(f.id), 0) : 0);
      return own(v.id);
    }
    case "system":
      return s.systemCount;
  }
}

/** The sidebar entry's name ("お気に入り"), for messages. */
export const sidebarEntryLabel = (id: string) => SIDEBAR_ENTRIES.find((e) => e.id === id)?.label ?? id;

/** Saves one setting of the open library, reporting failures. */
function saveLibrarySetting(key: string, value: unknown) {
  api.setLibrarySetting(key, value).catch((e) => useStore.getState().toast(String(e), true));
}

type SidebarState = Pick<State, "library" | "librarySettings" | "appSettings">;

/** Whose sidebar entries are in effect: the library's own, or the app's. */
export const sidebarScope = (s: SidebarState): SidebarScope =>
  s.library && s.librarySettings.sidebarOwn ? "library" : "app";

const NOTHING_HIDDEN: SidebarHidden = [];

/** Sidebar entries hidden in `scope` (default: the one in effect). */
export const sidebarHidden = (s: SidebarState, scope = sidebarScope(s)): SidebarHidden =>
  scope === "library" ? s.librarySettings.hidden : (s.appSettings?.sidebarHidden ?? NOTHING_HIDDEN);

/** Whether a sidebar entry (SIDEBAR_ENTRIES id) is hidden. */
export const isHidden = (s: SidebarState, id: string) => sidebarHidden(s).includes(id);

/** Sidebar entry a view is listed under, if it can be hidden. */
export function entryOfView(v: View): string | null {
  switch (v.kind) {
    case "folder":
      return "section:folders";
    case "smart":
      return "section:smart";
    case "tag":
      return "section:tags";
    case "fontScript":
      return "section:scripts";
    case "fontCategory":
      return "section:categories";
    case "all":
    case "trash":
      return null;
    default:
      return v.kind;
  }
}

export const useStore = create<State>((set, get) => ({
  library: null,
  librarySettings: DEFAULT_LIBRARY_SETTINGS,
  appSettings: null,

  view: { kind: "all" },
  search: "",
  tagFilter: [],
  tagMatchAll: load("tagMatchAll") === "true",
  sort: "importedAt",
  desc: true,
  thumbSize: loadNumber("thumbSize", 180),
  inspectorOpen: load("inspectorOpen") !== "false",
  sidebarOpen: load("sidebarOpen") !== "false",
  tocOpen: false,
  sidebarWidth: clampWidth("sidebar", loadNumber("sidebarWidth", PANEL_WIDTH.sidebar.initial)),
  inspectorWidth: clampWidth("inspector", loadNumber("inspectorWidth", PANEL_WIDTH.inspector.initial)),
  showSubfolders: load("showSubfolders") === "true",
  minRating: 0,
  filter: EMPTY_FILTER,
  editingSmart: null,
  layout: loadLayout(),
  specimenText: load("specimenText") ?? "",
  specimenSize: loadNumber("specimenSize", 40),
  tileSize: Math.min(TILE_SIZE.max, Math.max(TILE_SIZE.min, loadNumber("fontTileSize", TILE_SIZE.initial))),
  openFamilies: NO_FAMILIES,
  specimenFallback: load("specimenFallback") !== "false",
  showInfo: { name: true, rating: true, meta: false, ...loadJson("showInfo") },
  groupBy: loadGroupBy(),
  viewerInfo: load("viewerInfo") === "true",
  viewerStrip: load("viewerStrip") !== "false",
  viewerBare: load("viewerBare") === "true",
  tagClipboard: [],
  recentFolders: [],
  recentTags: [],
  renamingFolder: null,
  creatingTag: false,
  renameItemSeq: 0,
  picker: null,
  settingsTab: null,
  lastSettingsTab: "general",
  transfer: null,
  exporting: null,

  items: [],
  rawItems: [],
  shelf: [],
  panelTab: load("panelTab") === "shelf" ? "shelf" : "info",
  comparing: false,
  sections: [],
  folders: [],
  smartFolders: [],
  exts: [],
  tags: [],
  counts: {
    all: 0,
    unfiled: 0,
    untagged: 0,
    trash: 0,
    favorites: 0,
    pinned: 0,
    tray: 0,
    fontScripts: {},
    fontCategories: {},
    fontWeights: {},
    fontFeatures: {},
  },
  rev: 0,
  systemCount: null,

  selected: new Set(),
  anchor: null,
  focus: null,
  viewer: null,

  drag: null,
  fileDrag: false,
  dropTarget: null,
  flash: null,
  importing: null,
  updating: null,
  toasts: [],

  setLibrary: async (library) => {
    let librarySettings = DEFAULT_LIBRARY_SETTINGS;
    if (library) {
      try {
        librarySettings = parseLibrarySettings(await api.getLibrarySettings());
      } catch (e) {
        get().toast(String(e), true);
      }
    }
    set({
      library,
      librarySettings,
      items: [],
      rawItems: [],
      sections: [],
      shelf: [],
      comparing: false,
      openFamilies: NO_FAMILIES,
      view: { kind: "all" },
      search: "",
      tagFilter: [],
      minRating: 0,
      filter: EMPTY_FILTER,
      editingSmart: null,
      recentTags: library ? loadRecentTags(library.root) : [],
      selected: new Set(),
      anchor: null,
      focus: null,
      viewer: null,
    });
    if (library) {
      get().refresh();
      // Fonts whose details aren't read yet (grouping, search).
      fontApi
        .index()
        .then((n) => {
          if (n > 0) get().refresh();
        })
        .catch(() => {});
    }
  },
  setSidebarHidden: (ids, scope = sidebarScope(get())) => {
    if (scope === "app") {
      if (!get().appSettings) return;
      get().saveAppSettings({ sidebarHidden: ids });
    } else {
      set({ librarySettings: { ...get().librarySettings, hidden: ids } });
      saveLibrarySetting("hidden", ids.length ? ids : null);
    }
    leaveHidden();
  },
  setSidebarOwn: (own) => {
    const ls = get().librarySettings;
    if (!get().library || own === ls.sidebarOwn) return;
    let hidden = ls.hidden;
    // Starts from the app's entries, unless the library had its own before.
    if (own && !hidden.length) {
      hidden = [...(get().appSettings?.sidebarHidden ?? [])];
      saveLibrarySetting("hidden", hidden.length ? hidden : null);
    }
    set({ librarySettings: { ...ls, hidden, sidebarOwn: own } });
    saveLibrarySetting("sidebar", own ? "own" : "app");
    leaveHidden();
  },
  loadAppSettings: async () => {
    try {
      const app = await api.getAppSettings();
      set({ appSettings: { ...app, sidebarHidden: parseSidebarHidden(app.sidebarHidden) } });
      leaveHidden();
    } catch (e) {
      get().toast(String(e), true);
    }
  },
  saveAppSettings: (patch) => {
    const app = get().appSettings;
    if (!app) return;
    const next = { ...app, ...patch };
    set({ appSettings: next });
    api.setAppSettings(next).catch((e) => get().toast(String(e), true));
  },
  setView: (view) => {
    // The installed fonts (read the first time) may take a moment to
    // prepare; don't leave the old list up.
    const slow = view.kind === "system";
    const clear = slow && get().view.kind !== view.kind ? { items: [], rawItems: [], sections: [] } : {};
    // Conditions belong to the view they were set in: moving to another one
    // starts clean (re-selecting the open view keeps them).
    const moved = JSON.stringify(view) !== JSON.stringify(get().view);
    const reset = moved ? { search: "", tagFilter: [], minRating: 0, filter: EMPTY_FILTER, editingSmart: null } : {};
    set({
      view,
      // Going somewhere in the sidebar leaves the comparison for the list.
      comparing: false,
      selected: new Set(),
      anchor: null,
      focus: null,
      ...clear,
      ...reset,
    });
    get().refresh();
  },
  setSearch: (search) => {
    set({ search });
    get().refresh();
  },
  toggleTagFilter: (id) => {
    const cur = get().tagFilter;
    set({ tagFilter: cur.includes(id) ? cur.filter((t) => t !== id) : [...cur, id] });
    get().refresh();
  },
  clearTagFilter: () => {
    set({ tagFilter: [] });
    get().refresh();
  },
  setTagMatchAll: (tagMatchAll) => {
    set({ tagMatchAll });
    persist("tagMatchAll", String(tagMatchAll));
    if (get().tagFilter.length > 1) get().refresh();
  },
  setSort: (sort, desc) => {
    set({ sort, desc });
    get().refresh();
  },
  setSpecimenFallback: (specimenFallback) => {
    set({ specimenFallback });
    persist("specimenFallback", String(specimenFallback));
  },
  setSpecimenText: (specimenText) => {
    set({ specimenText });
    persist("specimenText", specimenText);
  },
  setSpecimenSize: (px) => {
    const specimenSize = Math.min(160, Math.max(12, Math.round(px)));
    set({ specimenSize });
    persist("specimenSize", String(specimenSize));
  },
  setTileSize: (px) => {
    const tileSize = Math.min(TILE_SIZE.max, Math.max(TILE_SIZE.min, Math.round(px)));
    set({ tileSize });
    persist("fontTileSize", String(tileSize));
  },
  saveSpecimenPattern: (text) => {
    if (!text.trim() || !get().library) return;
    const patterns = [text, ...get().librarySettings.patterns.filter((t) => t !== text)].slice(0, MAX_OWN_PATTERNS);
    set({ librarySettings: { ...get().librarySettings, patterns } });
    saveLibrarySetting("specimenPatterns", patterns);
  },
  removeSpecimenPattern: (text) => {
    const patterns = get().librarySettings.patterns.filter((t) => t !== text);
    set({ librarySettings: { ...get().librarySettings, patterns } });
    saveLibrarySetting("specimenPatterns", patterns.length ? patterns : null);
  },
  toggleFamily: (family) => {
    const open = new Set(get().openFamilies);
    if (!open.delete(family)) open.add(family);
    set(rearrange(get(), { openFamilies: open }));
  },
  setThumbSize: (thumbSize) => {
    set({ thumbSize });
    persist("thumbSize", String(thumbSize));
  },
  toggleInspector: () => {
    const inspectorOpen = !get().inspectorOpen;
    set({ inspectorOpen });
    persist("inspectorOpen", String(inspectorOpen));
  },
  setPanelTab: (panelTab) => {
    set({ panelTab, inspectorOpen: true });
    persist("panelTab", panelTab);
    persist("inspectorOpen", "true");
  },
  togglePanelTab: (tab) => {
    const s = get();
    if (s.inspectorOpen && s.panelTab === tab) s.toggleInspector();
    else s.setPanelTab(tab);
  },
  setComparing: (comparing) => set({ comparing }),
  toggleSidebar: () => {
    const sidebarOpen = !get().sidebarOpen;
    set({ sidebarOpen });
    persist("sidebarOpen", String(sidebarOpen));
  },
  setTocOpen: (tocOpen) => set({ tocOpen }),
  setPanelWidth: (panel, px) => {
    const w = clampWidth(panel, px);
    set(panel === "sidebar" ? { sidebarWidth: w } : { inspectorWidth: w });
    persist(`${panel}Width`, String(w));
  },
  setShowSubfolders: (showSubfolders) => {
    set({ showSubfolders });
    persist("showSubfolders", String(showSubfolders));
    get().refresh();
  },
  setMinRating: (minRating) => {
    set({ minRating });
    get().refresh();
  },
  setFilter: (patch) => {
    set({ filter: { ...get().filter, ...patch } });
    get().refresh();
  },
  clearConditions: () => {
    set({ search: "", tagFilter: [], minRating: 0, filter: EMPTY_FILTER });
    get().refresh();
  },
  currentRule: () => {
    const s = get();
    const { search, minRating, filter } = s;
    let { tagFilter, tagMatchAll } = s;
    // In a tag's place, the tag is a condition too (when the others all have to be on).
    const v = s.view;
    if (v.kind === "tag" && (tagFilter.length === 0 || tagMatchAll)) {
      tagFilter = [v.id, ...tagFilter.filter((t) => t !== v.id)];
      tagMatchAll = true;
    }
    return { search, tagIds: tagFilter, tagMatchAll, minRating, filter };
  },
  startEditSmart: (sf) => {
    // Edit in the "all" view so the user sees exactly what the rule matches.
    set({
      editingSmart: { id: sf.id, name: sf.name },
      view: { kind: "all" },
      comparing: false,
      search: sf.rule.search,
      tagFilter: sf.rule.tagIds,
      tagMatchAll: sf.rule.tagMatchAll,
      minRating: sf.rule.minRating,
      filter: { ...EMPTY_FILTER, ...sf.rule.filter },
      selected: new Set(),
    });
    get().refresh();
  },
  stopEditSmart: () => set({ editingSmart: null }),
  setLayout: (layout) => {
    persist("layout", layout);
    // Families open only in the specimen layout.
    set(rearrange(get(), { layout }));
  },
  setShowInfo: (patch) => {
    const showInfo = { ...get().showInfo, ...patch };
    set({ showInfo });
    persist("showInfo", JSON.stringify(showInfo));
  },
  setGroupBy: (groupBy) => {
    persist("groupBy", groupBy);
    // The viewer follows the item it was showing to its new place.
    set(rearrange(get(), { groupBy }));
  },
  toggleViewerInfo: () => {
    const viewerInfo = !get().viewerInfo;
    set({ viewerInfo });
    persist("viewerInfo", String(viewerInfo));
  },
  toggleViewerStrip: () => {
    const viewerStrip = !get().viewerStrip;
    set({ viewerStrip });
    persist("viewerStrip", String(viewerStrip));
  },
  toggleViewerBare: () => {
    const viewerBare = !get().viewerBare;
    set({ viewerBare });
    persist("viewerBare", String(viewerBare));
  },
  setTagClipboard: (tagClipboard) => set({ tagClipboard }),
  rememberFolders: (ids) => {
    const rest = get().recentFolders.filter((f) => !ids.includes(f));
    set({ recentFolders: [...ids, ...rest].slice(0, 8) });
  },
  // Takes names because new tags only get an id once the backend creates them;
  // they are resolved against the tag list after the next refresh.
  rememberTags: (names) => {
    pendingRecentTags = [...names, ...pendingRecentTags.filter((n) => !names.includes(n))];
  },
  setRenamingFolder: (renamingFolder) => set({ renamingFolder }),
  setCreatingTag: (creatingTag) => set({ creatingTag }),
  requestItemRename: () => set({ renameItemSeq: get().renameItemSeq + 1, inspectorOpen: true, panelTab: "info" }),
  setPicker: (picker) => set({ picker }),
  openSettings: (tab) =>
    set((s) => {
      if (tab === null) return { settingsTab: null };
      if (tab !== "last") return { settingsTab: tab, lastSettingsTab: tab };
      const last = s.lastSettingsTab;
      return { settingsTab: last.startsWith("library") && !s.library ? "general" : last };
    }),
  setTransfer: (transfer) => set({ transfer }),
  setExporting: (exporting) => set({ exporting }),

  refresh: async () => {
    if (!get().library) return;
    const seq = ++refreshSeq;
    const { view } = get();
    try {
      // The installed fonts aren't in the library: listed by features/fonts/system.ts.
      const system = view.kind === "system";
      // Which fonts are both in the library and installed (marked on both sides).
      refreshFontLinks();
      const [rawItems, folders, tags, counts, smartFolders, exts, trayItems] = await Promise.all([
        system ? querySystemFonts(listQuery(get())) : api.queryItems(listQuery(get())),
        api.listFolders(),
        api.listTags(),
        api.getCounts(),
        api.listSmartFolders(),
        api.listExts(),
        // The shelf, whatever the view and conditions.
        api.queryItems({
          view: { kind: "tray" },
          search: "",
          tagIds: [],
          tagMatchAll: false,
          includeSubfolders: false,
          minRating: 0,
          filter: EMPTY_FILTER,
          sort: "manual",
          desc: false,
        }),
      ]);
      // The shelf holds installed fonts too (docs/SYSTEM_FONTS.md).
      const shelf = await fontShelf(trayItems);
      const systemCount = system ? (await systemFonts()).length : null;
      if (seq !== refreshSeq) return; // a newer refresh superseded this one
      const { items, sections } = arrange({ ...get(), view, rawItems, tags, folders });
      const present = new Set(rowIds(items));
      const selected = new Set([...get().selected].filter((id) => present.has(id)));
      // Drop filters / views pointing at things that no longer exist.
      const tagIds = new Set(tags.map((t) => t.id));
      const tagFilterNow = get().tagFilter.filter((t) => tagIds.has(t));
      const viewNow = get().view;
      const viewGone =
        (viewNow.kind === "folder" && !folders.some((f) => f.id === viewNow.id)) ||
        (viewNow.kind === "tag" && !tags.some((t) => t.id === viewNow.id)) ||
        (viewNow.kind === "smart" && !smartFolders.some((f) => f.id === viewNow.id));
      const folderIds = new Set(folders.map((f) => f.id));
      const byName = new Map(tags.map((t) => [t.name, t.id]));
      const fresh = pendingRecentTags.flatMap((n) => byName.get(n) ?? []);
      // Keep names not created yet (a refresh that began before add_tags finished).
      pendingRecentTags = pendingRecentTags.filter((n) => !byName.has(n)).slice(0, 12);
      const recentTags = [...fresh, ...get().recentTags.filter((t) => !fresh.includes(t))]
        .filter((t) => tagIds.has(t))
        .slice(0, 12);
      if (fresh.length) persist(recentTagsKey(get().library!.root), JSON.stringify(recentTags));
      // Keep the viewer on the font it was showing even if the list moved.
      const prev = get();
      const shownId = prev.viewer !== null ? prev.items[prev.viewer]?.id : undefined;
      const viewerNow =
        prev.viewer === null || items.length === 0
          ? null
          : shownId && present.has(shownId)
            ? items.findIndex((i) => i.id === shownId)
            : Math.min(prev.viewer, items.length - 1);
      set({
        items,
        rawItems,
        shelf,
        sections,
        folders,
        smartFolders,
        exts,
        tags,
        counts,
        selected,
        rev: get().rev + 1,
        ...(systemCount !== null ? { systemCount } : {}),
        recentFolders: get().recentFolders.filter((f) => folderIds.has(f)),
        recentTags,
        viewer: viewerNow,
      });
      if (viewGone || tagFilterNow.length !== get().tagFilter.length) {
        set({ tagFilter: tagFilterNow, ...(viewGone ? { view: { kind: "all" } } : {}) });
        get().refresh();
      }
    } catch (e) {
      get().toast(String(e), true);
    }
  },

  select: (id, mode, at) => {
    const { selected, anchor, items } = get();
    const b = indexOf(items, id, at);
    // No anchor in the list any more (trashed, filtered out): a range from
    // nowhere would run from the top, so it starts here instead.
    const a = mode === "range" && anchor !== null ? indexOf(items, anchor, anchorAt) : -1;
    if (mode === "range" && a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      set({ selected: new Set(rowIds(items.slice(lo, hi + 1))), focus: id });
      return;
    }
    anchorAt = b >= 0 ? b : null;
    // A family row stands for all its fonts; an opened style row for itself.
    const own = idsAt(items, id, b);
    if (mode === "toggle") {
      const next = new Set(selected);
      if (next.has(id)) own.forEach((m) => next.delete(m));
      else own.forEach((m) => next.add(m));
      set({ selected: next, anchor: id, focus: id });
    } else {
      set({ selected: new Set(own), anchor: id, focus: id });
    }
  },
  setSelection: (ids) => {
    // The keyboard goes on from the last of them that is a row of the list
    // (a closed family's other fonts aren't).
    const rows = new Set(get().items.map((i) => i.id));
    let last = ids.at(-1) ?? null;
    for (let n = ids.length - 1; n >= 0; n--) {
      if (rows.has(ids[n])) {
        last = ids[n];
        break;
      }
    }
    anchorAt = null;
    set({ selected: new Set(ids), anchor: last, focus: last });
  },
  openViewer: (viewer) => set({ viewer }),

  setDrag: (drag) => set({ drag, dropTarget: drag ? get().dropTarget : null }),
  setDropTarget: (dropTarget) => {
    if (get().dropTarget !== dropTarget) set({ dropTarget });
  },
  setFileDrag: (fileDrag) => {
    if (get().fileDrag !== fileDrag) set({ fileDrag, ...(fileDrag ? {} : { dropTarget: null }) });
  },
  flashTarget: (target) => {
    const n = ++flashSeq;
    set({ flash: { target, n } });
    setTimeout(() => get().flash?.n === n && set({ flash: null }), 900);
  },
  setImporting: (importing) => set({ importing }),
  setUpdating: (updating) => set({ updating }),
  toast: (message, error, action) => get().notify({ title: message, kind: error ? "error" : "info", action }),
  notify: ({ title, detail, kind = "info", action, duration, replace }) => {
    const rev = ++toastSeq;
    const fields = {
      title,
      detail,
      kind,
      action,
      rev,
      duration: duration ?? toastDuration(kind, title + (detail ?? ""), !!action),
    };
    if (replace !== undefined && get().toasts.some((x) => x.id === replace && !x.leaving)) {
      set({ toasts: get().toasts.map((x) => (x.id === replace ? { ...fields, id: replace } : x)) });
      return replace;
    }
    const t: Toast = { ...fields, id: rev };
    // At most a handful on screen; the oldest give way.
    const live = get().toasts.filter((x) => !x.leaving);
    for (const old of live.slice(0, Math.max(0, live.length - 3))) get().dismissToast(old.id);
    set({ toasts: [...get().toasts, t] });
    return t.id;
  },
  dismissToast: (id) => {
    if (!get().toasts.some((t) => t.id === id && !t.leaving)) return;
    // Mark first so the exit animation can play, then remove.
    set({ toasts: get().toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), 200);
  },
  run: async (fn) => {
    let ok = true;
    try {
      await fn();
    } catch (e) {
      ok = false;
      get().toast(String(e), true);
    }
    await get().refresh();
    return ok;
  },
  importDone: (s, since) => {
    const parts = [];
    if (s.duplicates) parts.push(`${s.duplicates} 件はすでにあるためスキップ`);
    if (s.failed.length) parts.push(`${s.failed.length} 件は読み込めませんでした`);
    const title = s.imported ? `${s.imported} 件を追加しました` : "追加されたものはありません";
    const detail = parts.join(" / ") || undefined;
    get().notify({
      title,
      detail,
      kind: s.failed.length && !s.imported ? "error" : s.imported ? "success" : "info",
    });
    if (since !== undefined) notifyIfAway(since, title, detail);
    if (s.failed.length) warn("import failures", s.failed);
  },
}));

export function currentFolderId(): string | null {
  const v = useStore.getState().view;
  return v.kind === "folder" ? v.id : null;
}
