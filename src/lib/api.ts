// Typed wrappers around the Rust commands in src-tauri/src/commands.rs.
import { invoke } from "@tauri-apps/api/core";

export interface LibraryInfo {
  root: string;
  name: string;
}

/** A library opened or created before (the library switcher's list). */
export interface LibraryEntry extends LibraryInfo {
  favorite: boolean;
  /** ms; 0 = never opened here (only copied into). */
  lastOpened: number;
  /** False when the folder is gone (deleted, or on a disconnected drive). */
  exists: boolean;
  current: boolean;
}

/** Result of copying / moving items into another library (src-tauri/src/transfer.rs). */
export interface TransferSummary {
  copied: number;
  /** Already in the destination; their tags and folder were merged in. */
  duplicates: number;
  failed: string[];
  /**
   * Moving: how many went to this library's trash; null when another library
   * was opened (or this one closed) during the copy, so they stayed.
   */
  trashed: number | null;
}

/** Result of "ライブラリ全体を書き出し" (src-tauri/src/export.rs). */
export interface LibraryExport {
  /** The folder made for it ("<dest>/<library name>"). */
  folder: string;
  copied: number;
  total: number;
  /** Names of the items whose file couldn't be copied. */
  failed: string[];
  cancelled: boolean;
}

/** Settings of the whole app (settings.json): the settings screen's "一般" tab. */
export interface AppSettings {
  /** At launch: open the last library, or show the list to choose from. */
  startup: "last" | "choose";
  autoUpdate: boolean;
  /** Sidebar entries hidden, for libraries that follow the app's sidebar. */
  sidebarHidden: string[];
}

/**
 * Ids of the fonts installed on this computer (docs/SYSTEM_FONTS.md) start
 * with this: they are listed next to the library's but are not library items, so
 * nothing that changes items may be asked of them (src-tauri/src/fonts/system.rs).
 */
export const SYSTEM_ID_PREFIX = "sys:";
export const isSystemId = (id: string) => id.startsWith(SYSTEM_ID_PREFIX);
/** The ids that are library items (installed fonts left out). */
export const libraryIds = (ids: string[]) => ids.filter((id) => !isSystemId(id));

/** File types that can be added (src-tauri/src/import.rs `SUPPORTED_EXTS`). */
export const FONT_EXTS = ["ttf", "otf", "woff", "woff2", "ttc", "otc"];

/** Writing systems fonts are filed under (src-tauri/src/fonts/mod.rs `SCRIPTS`). */
export const FONT_SCRIPTS: { key: string; label: string }[] = [
  { key: "ja", label: "日本語" },
  { key: "latin", label: "欧文" },
  { key: "zh", label: "中国語" },
  { key: "ko", label: "韓国語" },
  { key: "other", label: "その他" },
];

/** Typeface styles (fonts.rs `CATEGORIES`); "none" = not known. */
export const FONT_CATEGORIES: { key: string; label: string }[] = [
  { key: "mincho", label: "明朝・セリフ" },
  { key: "gothic", label: "ゴシック・サンセリフ" },
  { key: "maru", label: "丸ゴシック" },
  { key: "slab", label: "スラブセリフ" },
  { key: "brush", label: "筆書体" },
  { key: "hand", label: "手書き" },
  { key: "display", label: "デザイン" },
  { key: "none", label: "未分類" },
];

/** Weight ranges (db.rs `FONT_WEIGHTS`); a variable font is in every range its wght axis spans. */
export const FONT_WEIGHTS: { key: string; label: string; names: string; range: string }[] = [
  { key: "light", label: "細い", names: "Thin–Light", range: "〜399" },
  { key: "regular", label: "標準", names: "Regular–Medium", range: "400〜549" },
  { key: "bold", label: "太い", names: "SemiBold–Bold", range: "550〜749" },
  { key: "black", label: "極太", names: "ExtraBold–Black", range: "750〜" },
];

/** Features a font has any number of (fonts.rs `FEATURES`). */
export const FONT_FEATURES: { key: string; label: string }[] = [
  { key: "mono", label: "等幅" },
  { key: "coding", label: "プログラミング向け" },
  { key: "variable", label: "可変フォント" },
  { key: "italic", label: "イタリック・斜体" },
];

export const fontScriptLabel = (k: string) => FONT_SCRIPTS.find((x) => x.key === k)?.label ?? k;
export const fontCategoryLabel = (k: string) => FONT_CATEGORIES.find((x) => x.key === k)?.label ?? k;
export const fontWeightLabel = (k: string) => FONT_WEIGHTS.find((x) => x.key === k)?.label ?? k;
export const fontFeatureLabel = (k: string) => FONT_FEATURES.find((x) => x.key === k)?.label ?? k;

/** A font's typeface style: the user's choice, else the guess, else "none". */
export const fontCategoryOf = (item: Pick<Item, "fontCategory" | "fontCategoryUser">) =>
  item.fontCategoryUser ?? item.fontCategory ?? "none";

export interface Item {
  id: string;
  name: string;
  fileName: string;
  ext: string;
  size: number;
  thumb: string;
  note: string;
  rating: number;
  importedAt: number;
  deletedAt: number | null;
  favorite: boolean;
  /** When the item was pinned to the top of lists; null = not pinned. */
  pinnedAt: number | null;
  /** The folder the item is in, if any (one at most). */
  folderId: string | null;
  tagIds: number[];
  /** Family shared by its styles (null until read) and weight 100-900. */
  fontFamily: string | null;
  fontWeight: number | null;
  /** Writing system (see FONT_SCRIPTS), null until read. */
  fontScript: string | null;
  /** Typeface style guessed from the font (null = can't tell) and the user's correction. */
  fontCategory: string | null;
  fontCategoryUser: string | null;
  /** Features (see FONT_FEATURES), empty until read. */
  fontFeatures: string[];
  /** PostScript name of the first font (null until read, or when it has none). */
  fontPsName: string | null;
  /**
   * An installed font on the font shelf that this computer doesn't have (the
   * library was put together on another one): only its name is known (docs/SYSTEM_FONTS.md).
   */
  unavailable?: boolean;
  /**
   * The row stands for a whole family; every font of it (the row's own id
   * first). Operations on the row reach them all.
   */
  familyIds?: string[];
  /** A style shown under its family's opened row (▸), indented. */
  familyMember?: boolean;
  /** On the shelf (シェルフ; the `tray` table). */
  inTray: boolean;
  filePath: string;
  thumbPath: string;
}

export type View =
  | { kind: "all" }
  | { kind: "unfiled" }
  | { kind: "untagged" }
  | { kind: "trash" }
  | { kind: "favorites" }
  | { kind: "pinned" }
  /** The shelf (the `tray` table): only queried for the shelf under the list, never opened as a list. */
  | { kind: "tray" }
  | { kind: "folder"; id: string }
  | { kind: "smart"; id: string }
  /** Items carrying a tag: the sidebar's tags are places like folders (docs/NAVIGATION.md). */
  | { kind: "tag"; id: number }
  /**
   * The fonts installed on this computer, read only and not in the library
   * (docs/SYSTEM_FONTS.md). Never sent to Rust: features/fonts/system.ts lists them.
   */
  | { kind: "system" };

/** Attribute filters (the filter row). Empty / null = no restriction. */
export interface Filter {
  /** Fonts of any of these writing systems / styles / weight ranges / features. */
  fontScripts: string[];
  fontCategories: string[];
  fontWeights: string[];
  fontFeatures: string[];
  exts: string[];
  /** ms; after inclusive, before exclusive. */
  importedAfter: number | null;
  importedBefore: number | null;
  /** bytes */
  minSize: number | null;
  maxSize: number | null;
}

export const EMPTY_FILTER: Filter = {
  fontScripts: [],
  fontCategories: [],
  fontWeights: [],
  fontFeatures: [],
  exts: [],
  importedAfter: null,
  importedBefore: null,
  minSize: null,
  maxSize: null,
};

/** Saved conditions of a smart folder (same shape as the ad-hoc ones). */
export interface Rule {
  search: string;
  tagIds: number[];
  tagMatchAll: boolean;
  minRating: number;
  filter: Filter;
}

export interface SmartFolder {
  id: string;
  name: string;
  rule: Rule;
  count: number;
  color: string | null;
}

export type SortKey = "importedAt" | "name" | "size" | "rating" | "manual";

export interface ItemQuery {
  view: View;
  search: string;
  tagIds: number[];
  /** true: items must carry every tag in `tagIds`; false: any one of them. */
  tagMatchAll: boolean;
  includeSubfolders: boolean;
  minRating: number;
  filter: Filter;
  sort: SortKey;
  desc: boolean;
}

/**
 * How many of a query's items have each value of each filter condition
 * (src-tauri/src/db.rs `facet_counts`). The filter row asks with the
 * condition whose menu is open left out: its counts are with the others on.
 */
export interface Facets {
  /** Items rated exactly n ("0" = unrated). */
  ratings: Record<string, number>;
  tags: Record<string, number>;
  /** File types, most first. */
  exts: [string, number][];
  fontScripts: Record<string, number>;
  fontCategories: Record<string, number>;
  fontWeights: Record<string, number>;
  fontFeatures: Record<string, number>;
}

export interface Counts {
  all: number;
  unfiled: number;
  untagged: number;
  trash: number;
  favorites: number;
  pinned: number;
  /** Items on the shelf (not in the trash). */
  tray: number;
  /** Fonts not in the trash by writing system and by style ("none" = unknown). */
  fontScripts: Record<string, number>;
  fontCategories: Record<string, number>;
  /** ... by weight range (a variable font under every range it spans) and by feature. */
  fontWeights: Record<string, number>;
  fontFeatures: Record<string, number>;
}

export interface Folder {
  id: string;
  parentId: string | null;
  name: string;
  count: number;
  /** Colour name (see lib/colors.ts), if set. */
  color: string | null;
}

export interface Tag {
  id: number;
  name: string;
  count: number;
  color: string | null;
}

export interface SelectionInfo {
  tags: Tag[];
  folders: { id: string; count: number }[];
}

export interface ImportSummary {
  imported: number;
  duplicates: number;
  failed: string[];
}

export const api = {
  /** `force`: open even when another PC has it open (see lib/libraryLock.ts). */
  openLastLibrary: (force = false) => invoke<LibraryInfo | null>("open_last_library", { force }),
  /** `open: false` only creates it (and adds it to the list). */
  createLibrary: (path: string, open = true, force = false) =>
    invoke<LibraryInfo>("create_library", { path, open, force }),
  openLibrary: (path: string, force = false) => invoke<LibraryInfo>("open_library", { path, force }),
  listLibraries: () => invoke<LibraryEntry[]>("list_libraries"),
  setLibraryFavorite: (path: string, favorite: boolean) => invoke<void>("set_library_favorite", { path, favorite }),
  forgetLibrary: (path: string) => invoke<void>("forget_library", { path }),
  getAppSettings: () => invoke<AppSettings>("get_app_settings"),
  setAppSettings: (settings: AppSettings) => invoke<AppSettings>("set_app_settings", { settings }),
  /** The open library's settings (library.db), JSON by key. */
  getLibrarySettings: () => invoke<Record<string, unknown>>("get_library_settings"),
  /** `null` removes the setting. */
  setLibrarySetting: (key: string, value: unknown) => invoke<void>("set_library_setting", { key, value }),
  librarySize: () => invoke<number>("library_size"),
  /** Without `ids`, every item not in the trash. `move` puts them in this library's trash afterwards. */
  transferItems: (dest: string, ids: string[] | null, move: boolean) =>
    invoke<TransferSummary>("transfer_items", { dest, ids, moveItems: move }),

  queryItems: (query: ItemQuery) => invoke<Item[]>("query_items", { query }),
  facetCounts: (query: ItemQuery) => invoke<Facets>("facet_counts", { query }),
  /** Totals for the sidebar. */
  getCounts: () => invoke<Counts>("get_counts"),
  selectionInfo: (ids: string[]) => invoke<SelectionInfo>("selection_info", { ids }),
  setNote: (id: string, note: string) => invoke<void>("set_note", { id, note }),
  renameItem: (id: string, name: string) => invoke<void>("rename_item", { id, name }),
  trashItems: (ids: string[]) => invoke<void>("trash_items", { ids }),
  restoreItems: (ids: string[]) => invoke<void>("restore_items", { ids }),
  deleteItems: (ids: string[]) => invoke<void>("delete_items", { ids }),
  emptyTrash: () => invoke<void>("empty_trash"),
  revealItem: (id: string) => invoke<void>("reveal_item", { id }),
  openItems: (ids: string[]) => invoke<void>("open_items", { ids }),
  setRating: (ids: string[], rating: number) => invoke<void>("set_rating", { ids, rating }),
  setFavorite: (ids: string[], on: boolean) => invoke<void>("set_favorite", { ids, on }),
  /** Pinned items come first in every list. */
  setPinned: (ids: string[], on: boolean) => invoke<void>("set_pinned", { ids, on }),
  copyItems: (ids: string[]) => invoke<number>("copy_items", { ids }),
  /** `subdirs[i]`: folder under `dest` for `ids[i]` ("和文/ゴシック", "" = `dest` itself). */
  exportItems: (ids: string[], dest: string, subdirs?: string[]) =>
    invoke<number>("export_items", { ids, dest, subdirs: subdirs ?? null }),
  /**
   * Every item not in the trash into a new "<library name>" folder in `dest`,
   * in "<folders>/…". Reports "export-progress".
   */
  exportLibrary: (dest: string) => invoke<LibraryExport>("export_library", { dest }),
  /** Stops `exportLibrary` after the file it is copying. */
  cancelExport: () => invoke<void>("cancel_export"),

  /** Puts items on the shelf, after the ones there; returns how many were new. */
  addToTray: (ids: string[]) => invoke<number>("add_to_tray", { ids }),
  removeFromTray: (ids: string[]) => invoke<void>("remove_from_tray", { ids }),
  /** Empties the shelf; returns what was on it, in order (to put it back). */
  clearTray: () => invoke<string[]>("clear_tray"),
  reorderTray: (ids: string[], before: string | null) => invoke<void>("reorder_tray", { ids, before }),
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  revealLog: () => invoke<void>("reveal_log"),
  /** The proxy the OS uses for the update feed (PAC included); null = direct. For the updater. */
  systemProxy: () => invoke<string | null>("system_proxy"),
  /** The GitHub release page of `version` (what changed), in the browser. Same repository as the update feed. */
  openReleasePage: (version: string) => invoke<void>("open_release_page", { version }),

  importPaths: (paths: string[], folderId: string | null) =>
    invoke<ImportSummary>("import_paths", { paths, folderId }),
  importBytes: (name: string, data: Uint8Array, folderId: string | null) =>
    invoke<ImportSummary>("import_bytes", data, {
      headers: { "x-name": encodeURIComponent(name), "x-folder": folderId ?? "" },
    }),
  supportedExts: () => invoke<string[]>("supported_exts"),
  listFolders: () => invoke<Folder[]>("list_folders"),
  createFolder: (name: string, parentId: string | null) => invoke<string>("create_folder", { name, parentId }),
  renameFolder: (id: string, name: string) => invoke<void>("rename_folder", { id, name }),
  deleteFolder: (id: string) => invoke<void>("delete_folder", { id }),
  moveFolder: (id: string, parentId: string | null) =>
    invoke<boolean>("move_folder", { id, parentId }),
  /** An item is in one folder at most: this takes it out of the one it was in. */
  moveToFolder: (ids: string[], folderId: string) => invoke<void>("move_to_folder", { ids, folderId }),
  reorderInFolder: (folderId: string, ids: string[], before: string | null) =>
    invoke<void>("reorder_in_folder", { folderId, ids, before }),
  placeFolder: (id: string, parentId: string | null, before: string | null) =>
    invoke<boolean>("place_folder", { id, parentId, before }),
  /** -1 / +1 = up / down one; very large values move to the top / bottom. */
  shiftFolder: (id: string, by: number) => invoke<void>("shift_folder", { id, by }),
  /** `parentId` null: the top level. */
  sortFoldersByName: (parentId: string | null) => invoke<void>("sort_folders_by_name", { parentId }),
  listSmartFolders: () => invoke<SmartFolder[]>("list_smart_folders"),
  createSmartFolder: (name: string, rule: Rule) => invoke<string>("create_smart_folder", { name, rule }),
  updateSmartFolder: (id: string, patch: { name?: string; rule?: Rule }) =>
    invoke<void>("update_smart_folder", { id, name: patch.name ?? null, rule: patch.rule ?? null }),
  deleteSmartFolder: (id: string) => invoke<void>("delete_smart_folder", { id }),
  listExts: () => invoke<[string, number][]>("list_exts"),
  removeFromFolder: (ids: string[], folderId: string) =>
    invoke<void>("remove_from_folder", { ids, folderId }),

  listTags: () => invoke<Tag[]>("list_tags"),
  /** Tags are made where missing. */
  addTags: (ids: string[], names: string[]) => invoke<void>("add_tags", { ids, names }),
  removeTag: (ids: string[], tagId: number) => invoke<void>("remove_tag", { ids, tagId }),
  renameTag: (id: number, name: string) => invoke<void>("rename_tag", { id, name }),
  deleteTag: (id: number) => invoke<void>("delete_tag", { id }),
  /** `color` null clears it. */
  setFolderColor: (id: string, color: string | null) => invoke<void>("set_folder_color", { id, color }),
  setSmartFolderColor: (id: string, color: string | null) =>
    invoke<void>("set_smart_folder_color", { id, color }),
  setTagColor: (id: number, color: string | null) => invoke<void>("set_tag_color", { id, color }),
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
