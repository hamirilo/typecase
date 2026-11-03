// Settings stored in the library itself (library.db `settings`, see
// docs/SETTINGS.md): the sidebar entries hidden and the specimen texts saved.
// They travel with the library. The sidebar can instead follow the app's
// (settings.json `sidebarHidden`).

export interface LibrarySettings {
  /** Sidebar entries hidden; used when `sidebarOwn`. */
  hidden: SidebarHidden;
  /** The library has its own sidebar entries; otherwise it follows the app's. */
  sidebarOwn: boolean;
  /** Specimen texts the user saved (the pattern menu's "自分のパターン"), newest first. */
  patterns: string[];
}

/** Sidebar entries hidden (ids of `SIDEBAR_ENTRIES`). */
export type SidebarHidden = string[];

export const DEFAULT_LIBRARY_SETTINGS: LibrarySettings = { hidden: [], sidebarOwn: false, patterns: [] };

/** Sidebar entries that can be hidden. "すべて" and "ゴミ箱" always stay. */
export const SIDEBAR_ENTRIES: { id: string; label: string }[] = [
  { id: "unfiled", label: "未分類" },
  { id: "untagged", label: "タグなし" },
  { id: "system", label: "この端末のフォント" },
  { id: "favorites", label: "お気に入り" },
  { id: "pinned", label: "ピン留め" },
  { id: "section:folders", label: "フォルダ" },
  { id: "section:smart", label: "スマートフォルダ" },
  { id: "section:tags", label: "タグ" },
];

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Entries this version knows, of a stored list. */
export function parseSidebarHidden(raw: unknown): SidebarHidden {
  const known = new Set(SIDEBAR_ENTRIES.map((e) => e.id));
  return strings(raw).filter((id) => known.has(id));
}

/** Reads the stored JSON, skipping keys and entries this version doesn't know. */
export function parseLibrarySettings(raw: Record<string, unknown>): LibrarySettings {
  return {
    hidden: parseSidebarHidden(raw.hidden),
    sidebarOwn: raw.sidebar === "own",
    patterns: strings(raw.specimenPatterns).filter((t) => t.trim()),
  };
}
