// Dev-only in-memory stand-in for the Rust backend, used when the UI is
// opened in a normal browser (`bun run dev`) instead of inside Tauri.
// Mirrors the semantics of src-tauri/src/db.rs closely enough for UI work.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { FONT_EXTS, type Folder, type Item, type ItemQuery, type Rule, type Tag } from "../lib/api";
import type { SystemFont } from "../features/fonts/api";

type MockItem = Omit<
  Item,
  | "filePath"
  | "thumbPath"
  | "folderId"
  | "tagIds"
  | "fontFamily"
  | "fontWeight"
  | "fontScript"
  | "fontCategory"
  | "fontCategoryUser"
  | "fontFeatures"
  | "fontPsName"
  | "inTray"
> & {
  fontFamily?: string;
  fontWeight?: number;
  /** The wght axis of a variable font; else the one weight. */
  fontWeightMin?: number;
  fontWeightMax?: number;
  fontScript?: string;
  fontCategory?: string | null;
  fontCategoryUser?: string | null;
  fontFeatures?: string[];
  fontPsName?: string;
};

const items: MockItem[] = [];

/**
 * The fonts "installed on this computer" (src-tauri/src/fonts/system.rs): the
 * この端末のフォント, read only (docs/SYSTEM_FONTS.md).
 */
const systemFonts: SystemFont[] = (
  [
    ["ヒラギノ角ゴシック W3", "HiraginoSans-W3", "ヒラギノ角ゴシック", 300, "ja", "gothic", [], "ttc", "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc"],
    ["ヒラギノ角ゴシック W6", "HiraginoSans-W6", "ヒラギノ角ゴシック", 600, "ja", "gothic", [], "ttc", "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc"],
    ["ヒラギノ明朝 ProN W3", "HiraMinProN-W3", "ヒラギノ明朝 ProN", 300, "ja", "mincho", [], "ttc", "/System/Library/Fonts/ヒラギノ明朝 ProN.ttc"],
    ["Helvetica", "Helvetica", "Helvetica", 400, "latin", "gothic", [], "ttc", "/System/Library/Fonts/Helvetica.ttc"],
    ["Georgia", "Georgia", "Georgia", 400, "latin", "mincho", [], "ttf", "/System/Library/Fonts/Supplemental/Georgia.ttf"],
    ["Menlo Regular", "Menlo-Regular", "Menlo", 400, "latin", "gothic", ["mono", "coding"], "ttc", "/System/Library/Fonts/Menlo.ttc"],
    ["SF Pro", "SFNS-Regular", "SF Pro", 400, "latin", "gothic", ["variable"], "ttf", "/System/Library/Fonts/SFNS.ttf"],
    ["Noto Sans JP Regular", "NotoSansJP-Regular", "Noto Sans JP", 400, "ja", "gothic", [], "otf", "/Users/me/Library/Fonts/NotoSansJP-Regular.otf"],
  ] as [string, string, string, number, string, string, string[], string, string][]
).map(([name, psName, family, weight, script, category, features, ext, path], k) => ({
  id: `sys:mock${k}`,
  path,
  fileName: path.split("/").pop()!,
  ext,
  size: 1_000_000 + k * 731_000,
  modified: Date.UTC(2025, k % 12, 1 + k),
  name,
  psName,
  family,
  weight,
  weightMin: features.includes("variable") ? 100 : weight,
  weightMax: features.includes("variable") ? 900 : weight,
  script,
  category,
  features,
}));

/** A library font, or an installed one shaped like it (the font commands take both ids). */
const fontItem = (fid: string): MockItem => {
  const it = items.find((i) => i.id === fid);
  if (it) return it;
  const f = systemFonts.find((x) => x.id === fid);
  if (!f) throw "フォントが見つかりません";
  return {
    ...({} as MockItem),
    id: f.id,
    name: f.name,
    ext: f.ext,
    fontFamily: f.family,
    fontWeight: f.weight,
    fontScript: f.script,
  };
};

/** Weight ranges of the 太さ, as in db.rs `FONT_WEIGHTS`. */
const FONT_WEIGHT_RANGES: [string, number, number][] = [
  ["light", 1, 399],
  ["regular", 400, 549],
  ["bold", 550, 749],
  ["black", 750, 9999],
];
const inWeight = (i: MockItem, key: string) => {
  const r = FONT_WEIGHT_RANGES.find(([k]) => k === key);
  if (!r) return false;
  const [lo, hi] = [i.fontWeightMin ?? i.fontWeight ?? 400, i.fontWeightMax ?? i.fontWeight ?? 400];
  return lo <= r[2] && hi >= r[1];
};
const folders: Omit<Folder, "count">[] = [];
const tags: { id: number; name: string; color: string | null }[] = [];
// `${itemId}|${folderId}` -> manual position
const itemFolders = new Map<string, number>();
let posSeq = 0;
// An item is in at most one folder; linking moves it.
const link = (i: string, f: string) => {
  if (itemFolders.has(`${i}|${f}`)) return;
  [...itemFolders.keys()].filter((k) => k.startsWith(`${i}|`)).forEach((k) => itemFolders.delete(k));
  itemFolders.set(`${i}|${f}`, ++posSeq);
};
const itemTags = new Set<string>(); // `${itemId}|${tagId}`
// The shelf (the `tray` table): item id -> position.
const tray = new Map<string, number>();
// Installed fonts on the shelf (their ids are in `tray` too, for the one order): id -> name.
const systemTrayNames = new Map<string, string>();
let traySeq = 0;
const smartFolders: { id: string; name: string; rule: Rule; color: string | null }[] = [];
let tagSeq = 0;
let uid = 0;
const id = () => `m${(++uid).toString(36)}`;

function seed() {
  // An installed font put on the shelf on another computer, which this one doesn't have.
  tray.set("sys:elsewhere", ++traySeq);
  systemTrayNames.set("sys:elsewhere", "游明朝体 Pr6N R");
  // Noto Sans JP comes as one file per weight (grouped by family), Inter as one variable font.
  const fontFiles: [string, string, number, string, string | null, string[], [number, number]?][] = [
    ["NotoSansJP-Bold.ttf", "Noto Sans JP", 700, "ja", "gothic", []],
    ["NotoSansJP-Regular.ttf", "Noto Sans JP", 400, "ja", "gothic", []],
    ["Inter[wght].woff2", "Inter", 400, "latin", "gothic", ["variable"], [100, 900]],
    ["Hiragino.ttc", "ヒラギノ角ゴシック", 300, "ja", "gothic", []],
    ["NotoSansJP-Light.ttf", "Noto Sans JP", 300, "ja", "gothic", []],
    ["NotoSerifJP-Regular.otf", "Noto Serif JP", 400, "ja", "mincho", []],
    ["NotoSerifJP-Bold.otf", "Noto Serif JP", 700, "ja", "mincho", []],
    ["Garamond-Italic.otf", "EB Garamond", 400, "latin", "mincho", ["italic"]],
    ["Garamond-Regular.otf", "EB Garamond", 400, "latin", "mincho", []],
    ["JetBrainsMono-Regular.ttf", "JetBrains Mono", 400, "latin", "gothic", ["mono", "coding"]],
    ["RobotoSlab-Regular.ttf", "Roboto Slab", 400, "latin", "slab", []],
    ["MPLUSRounded1c-Regular.ttf", "M PLUS Rounded 1c", 400, "ja", "maru", []],
    ["keifont.ttf", "けいふぉんと", 400, "ja", "hand", []],
    ["Yuji-Syuku.ttf", "Yuji Syuku", 400, "ja", "brush", []],
    ["Lobster-Regular.ttf", "Lobster", 400, "latin", "display", []],
    ["NotoSansKR-Regular.otf", "Noto Sans KR", 400, "ko", "gothic", []],
    ["NotoSansSC-Regular.otf", "Noto Sans SC", 400, "zh", "gothic", []],
  ];
  for (const [i, [file, fontFamily, fontWeight, fontScript, fontCategory, fontFeatures, range]] of fontFiles.entries()) {
    items.push({
      fontFamily,
      fontWeight,
      fontWeightMin: range?.[0] ?? fontWeight,
      fontWeightMax: range?.[1] ?? fontWeight,
      fontScript,
      fontCategory,
      fontFeatures,
      // The file's name for most; the Hiragino and Noto Sans JP Regular are installed too (`systemFonts`).
      fontPsName: file === "Hiragino.ttc" ? "HiraginoSans-W3" : file.replace(/\.[^.]+$/, ""),
      id: id(),
      name: file,
      fileName: file,
      ext: file.split(".").pop()!,
      size: 300_000 * (i + 1),
      thumb: "",
      note: "",
      rating: i % 5 === 0 ? 4 : i % 7 === 0 ? 2 : 0,
      importedAt: Date.now() - (fontFiles.length - i) * 3_600_000,
      deletedAt: null,
      favorite: i % 6 === 0,
      pinnedAt: i === 3 ? Date.now() : null,
    });
  }
  const ja = { id: id(), parentId: null, name: "和文", color: "purple" };
  folders.push(
    ja,
    { id: id(), parentId: ja.id, name: "本文", color: null },
    { id: id(), parentId: null, name: "欧文", color: "teal" },
  );
  items.filter((i) => i.fontScript === "ja").forEach((it) => link(it.id, ja.id));
  items.filter((i) => i.fontFamily?.startsWith("Noto Sans JP")).forEach((it) => link(it.id, folders[1].id));
  items.filter((i) => i.fontScript === "latin").forEach((it) => link(it.id, folders[2].id));
  addTags(items.slice(0, 4).map((i) => i.id), ["本文", "候補"]);
  addTags(items.slice(6, 10).map((i) => i.id), ["見出し"]);
}

/** Font thumbnail: "Aa" and a line of sample text, like fonts/mod.rs renders it. */
function fontSvg(it: MockItem) {
  const weight = it.fontWeight ?? 400;
  const s = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="384"><rect width="100%" height="100%" fill="#f4f4f5"/><g font-family="sans-serif" font-weight="${weight}" fill="#18181b" text-anchor="middle"><text x="256" y="215" font-size="170">Aa</text><text x="256" y="320" font-size="52">${it.fontScript === "ja" ? "あア永" : "ABC abc 123"}</text></g></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s)}`;
}

const view = (it: MockItem): Item => {
  const folderId = folders.find((f) => inFolder(it.id, f.id))?.id ?? null;
  const tagIds = tags.filter((t) => hasTag(it.id, t.id)).map((t) => t.id);
  return {
    ...it,
    fontFamily: it.fontFamily ?? null,
    fontWeight: it.fontWeight ?? null,
    fontScript: it.fontScript ?? null,
    fontCategory: it.fontCategory ?? null,
    fontCategoryUser: it.fontCategoryUser ?? null,
    fontFeatures: it.fontFeatures ?? [],
    fontPsName: it.fontPsName ?? null,
    inTray: tray.has(it.id),
    folderId,
    tagIds,
    filePath: `/mock/fonts/${it.id}/${it.fileName}`,
    thumbPath: fontSvg(it),
  };
};
const inFolder = (i: string, f: string) => itemFolders.has(`${i}|${f}`);
const hasTag = (i: string, t: number) => itemTags.has(`${i}|${t}`);
const live = () => items.filter((i) => i.deletedAt === null);

/** Tags items by name, made where missing (db.rs `add_tags`). */
function addTags(ids: string[], names: string[]) {
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    let t = tags.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!t) tags.push((t = { id: ++tagSeq, name, color: name === "候補" ? "blue" : null }));
    for (const i of ids) itemTags.add(`${i}|${t.id}`);
  }
}

function descendants(fid: string): string[] {
  return [fid, ...folders.filter((f) => f.parentId === fid).flatMap((f) => descendants(f.id))];
}

const ext = (e: string) => e.toLowerCase();

// Simplified search (AND + "-exclude"); the real parser lives in src-tauri/src/search.rs.
function applyRule(r: MockItem[], rule: Rule): MockItem[] {
  for (const raw of rule.search.toLowerCase().split(/\s+/).filter(Boolean)) {
    const neg = raw.startsWith("-") && raw.length > 1;
    const w = neg ? raw.slice(1) : raw;
    const hit = (i: MockItem) =>
      i.name.toLowerCase().includes(w) ||
      i.note.toLowerCase().includes(w) ||
      (i.fontFamily ?? "").toLowerCase().includes(w) ||
      tags.some((t) => hasTag(i.id, t.id) && t.name.toLowerCase().includes(w));
    r = r.filter((i) => hit(i) !== neg);
  }
  const tagIds = rule.tagIds.filter((t) => tags.some((x) => x.id === t));
  if (tagIds.length) {
    const need = rule.tagMatchAll ? tagIds.length : 1;
    r = r.filter((i) => tagIds.filter((t) => hasTag(i.id, t)).length >= need);
  }
  if (rule.minRating) r = r.filter((i) => i.rating >= rule.minRating);
  const f = rule.filter;
  if (!f) return r;
  if (f.fontScripts?.length) r = r.filter((i) => f.fontScripts.includes(i.fontScript ?? ""));
  if (f.fontCategories?.length)
    r = r.filter((i) => f.fontCategories.includes(i.fontCategoryUser ?? i.fontCategory ?? "none"));
  if (f.fontWeights?.length) r = r.filter((i) => f.fontWeights.some((k) => inWeight(i, k)));
  if (f.fontFeatures?.length) r = r.filter((i) => f.fontFeatures.some((k) => (i.fontFeatures ?? []).includes(k)));
  if (f.exts?.length) r = r.filter((i) => f.exts.map(ext).includes(ext(i.ext)));
  const within = (v: number, min: number | null, max: number | null) =>
    (min == null || v >= min) && (max == null || v <= max);
  return r.filter(
    (i) =>
      within(i.size, f.minSize, f.maxSize) &&
      (f.importedAfter == null || i.importedAt >= f.importedAfter) &&
      (f.importedBefore == null || i.importedAt < f.importedBefore),
  );
}

/** Puts `fid` among the children of `parent`, before sibling `before` (null = last). */
function placeFolder(fid: string, parent: string | null, before: string | null): boolean {
  for (let c: string | null = parent; c; c = folders.find((f) => f.id === c)?.parentId ?? null) {
    if (c === fid) return false;
  }
  const f = folders.splice(folders.findIndex((x) => x.id === fid), 1)[0];
  f.parentId = parent;
  const at = before ? folders.findIndex((x) => x.id === before) : -1;
  folders.splice(at < 0 ? folders.length : at, 0, f);
  return true;
}

/** Rewrites the order of `parent`'s children (array order = sibling order). */
function reorderSiblings(parent: string | null, order: (sibs: typeof folders) => typeof folders) {
  const slots = folders.map((f, i) => (f.parentId === parent ? i : -1)).filter((i) => i >= 0);
  const next = order(slots.map((i) => folders[i]));
  slots.forEach((slot, k) => (folders[slot] = next[k]));
}

/** The items a query matches, unsorted (as db.rs `query_where`). */
function matched(q: ItemQuery): MockItem[] {
  let r = q.view.kind === "trash" ? items.filter((i) => i.deletedAt !== null) : live();
  const v = q.view;
  if (v.kind === "unfiled") r = r.filter((i) => !folders.some((f) => inFolder(i.id, f.id)));
  if (v.kind === "untagged") r = r.filter((i) => !tags.some((t) => hasTag(i.id, t.id)));
  if (v.kind === "favorites") r = r.filter((i) => i.favorite);
  if (v.kind === "pinned") r = r.filter((i) => i.pinnedAt !== null);
  if (v.kind === "tray") r = r.filter((i) => tray.has(i.id));
  if (v.kind === "tag") r = r.filter((i) => hasTag(i.id, v.id));
  if (v.kind === "fontScript") r = r.filter((i) => i.fontScript === v.id);
  if (v.kind === "fontCategory") r = r.filter((i) => (i.fontCategoryUser ?? i.fontCategory ?? "none") === v.id);
  if (v.kind === "folder") {
    const ids = q.includeSubfolders ? descendants(v.id) : [v.id];
    r = r.filter((i) => ids.some((f) => inFolder(i.id, f)));
  }
  r = applyRule(r, q);
  if (v.kind === "smart") {
    const sf = smartFolders.find((f) => f.id === v.id);
    r = sf ? applyRule(r, sf.rule) : [];
  }
  return r;
}

function countBy<T>(xs: T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
}

/** Counts by writing system, style, weight range and feature, of fonts whose details were read. */
function fontCounts(list: MockItem[]) {
  const fonts = list.filter((i) => i.fontScript);
  return {
    fontScripts: countBy(fonts, (i) => i.fontScript ?? "other"),
    fontCategories: countBy(fonts, (i) => i.fontCategoryUser ?? i.fontCategory ?? "none"),
    fontWeights: Object.fromEntries(
      FONT_WEIGHT_RANGES.map(([k]) => [k, fonts.filter((i) => inWeight(i, k)).length]).filter(([, n]) => n),
    ),
    fontFeatures: countBy(
      fonts.flatMap((i) => (i.fontFeatures ?? []).map((k) => ({ k }))),
      (x) => x.k,
    ),
  };
}

/** Counts per value of each filter condition, as db.rs `facet_counts`. */
function facets(q: ItemQuery) {
  const r = matched(q);
  const exts = countBy(r, (i) => ext(i.ext));
  return {
    ratings: countBy(r, (i) => String(i.rating)),
    tags: Object.fromEntries(
      tags.map((t) => [t.id, r.filter((i) => hasTag(i.id, t.id)).length]).filter(([, n]) => n),
    ),
    exts: Object.entries(exts).sort((x, y) => y[1] - x[1]),
    ...fontCounts(r),
  };
}

function query(q: ItemQuery): Item[] {
  let r = matched(q);
  const v = q.view;
  // Pinned items lead every list, latest pin first.
  const pin = (a: MockItem, b: MockItem) => (b.pinnedAt ?? -Infinity) - (a.pinnedAt ?? -Infinity);
  // The shelf's own order ignores pins, as in db.rs.
  if (q.sort === "manual" && v.kind === "tray") {
    return [...r].sort((a, b) => tray.get(a.id)! - tray.get(b.id)!).map(view);
  }
  if (q.sort === "manual" && v.kind === "folder") {
    const pos = (i: MockItem) => itemFolders.get(`${i.id}|${v.id}`) ?? Infinity;
    return [...r].sort((a, b) => pin(a, b) || pos(a) - pos(b)).map(view);
  }
  const key = (i: MockItem): number | string =>
    q.sort === "name" ? i.name.toLowerCase() : q.sort === "size" ? i.size : q.sort === "rating" ? i.rating : i.importedAt;
  r = [...r].sort((a, b) => pin(a, b) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * (q.desc ? -1 : 1));
  return r.map(view);
}

function removeFolder(fid: string) {
  folders.filter((f) => f.parentId === fid).forEach((f) => removeFolder(f.id));
  folders.splice(folders.findIndex((f) => f.id === fid), 1);
  [...itemFolders.keys()].filter((k) => k.endsWith(`|${fid}`)).forEach((k) => itemFolders.delete(k));
}

const mockLibraries = [
  { root: "/mock/Demo.library", name: "Demo (mock)", favorite: true, lastOpened: 3, exists: true, current: true },
  { root: "/Users/me/Documents/Work.library", name: "Work", favorite: false, lastOpened: 2, exists: true, current: false },
  { root: "/Volumes/Archive/Old.library", name: "Old", favorite: false, lastOpened: 1, exists: false, current: false },
];

// library.db `settings` (JSON by key) and settings.json's app settings.
const librarySettings: Record<string, unknown> = {};
const appSettings = { startup: "last", autoUpdate: true, sidebarHidden: [] as string[] };

// The menu bar (src/lib/menuBar.ts): items by resource id, and the menu set
// as the app menu, for checking its structure in the browser
// (`window.__MOCK_MENU__()` prints it as text).
const menuItems = new Map<number, { kind: string; options: any }>();
let menuSeq = 0;
let appMenu: number | null = null;
function menuText(rid: number, depth = 0): string[] {
  const m = menuItems.get(rid);
  if (!m) return [];
  const o = m.options ?? {};
  const pad = "  ".repeat(depth);
  const flags = `${o.enabled === false ? " [off]" : ""}${o.checked ? " ✓" : ""}${o.accelerator ? `  <${o.accelerator}>` : ""}`;
  const name = m.kind === "Predefined" ? `(${typeof o.item === "string" ? o.item : "About"})` : (o.text ?? "");
  const head = m.kind === "Menu" ? [] : [`${pad}${name}${flags}`];
  const kids = (o.items ?? []).flatMap((i: [number, string]) => menuText(i[0], m.kind === "Menu" ? depth : depth + 1));
  return [...head, ...kids];
}
(window as unknown as { __MOCK_MENU__: () => string }).__MOCK_MENU__ = () =>
  appMenu === null ? "(no menu)" : menuText(appMenu).join("\n");

function handle(cmd: string, a: any): unknown {
  if (cmd.startsWith("plugin:menu|")) {
    const op = cmd.slice("plugin:menu|".length);
    if (op === "new") {
      const rid = ++menuSeq;
      menuItems.set(rid, { kind: a.kind, options: a.options });
      return [rid, `m${rid}`];
    }
    if (op === "set_as_app_menu") {
      appMenu = a.rid;
      return null;
    }
    const item = menuItems.get(a.rid);
    if (item && op === "set_text") item.options.text = a.text;
    if (item && op === "set_enabled") item.options.enabled = a.enabled;
    if (item && op === "set_checked") item.options.checked = a.checked;
    return null;
  }
  switch (cmd) {
    case "open_last_library":
    case "create_library":
    case "open_library":
      // "Work" acts as open on another PC (library.lock), to try the question.
      if (a.path?.endsWith("Work.library") && !a.force)
        throw `LOCKED:${JSON.stringify({ machine: "x", name: "会議室の Windows", pid: 1, at: Date.now() - 60_000 })}`;
      return { root: "/mock/Demo.library", name: "Demo (mock)" };
    case "list_libraries":
      return mockLibraries;
    case "get_app_settings":
      return { ...appSettings };
    case "set_app_settings":
      Object.assign(appSettings, a.settings);
      return { ...appSettings };
    case "get_library_settings":
      return { ...librarySettings };
    case "set_library_setting":
      if (a.value === null) delete librarySettings[a.key];
      else librarySettings[a.key] = a.value;
      return null;
    case "library_size":
      return items.reduce((n, i) => n + i.size, 0);
    case "set_library_favorite": {
      const l = mockLibraries.find((x) => x.root === a.path);
      if (l) l.favorite = a.favorite;
      mockLibraries.sort((x, y) => Number(y.favorite) - Number(x.favorite) || y.lastOpened - x.lastOpened);
      return null;
    }
    case "forget_library":
      mockLibraries.splice(mockLibraries.findIndex((x) => x.root === a.path), 1);
      return null;
    case "transfer_items": {
      const ids: string[] = a.ids ?? live().map((i) => i.id);
      if (a.moveItems) for (const i of items) if (ids.includes(i.id)) i.deletedAt = Date.now();
      return { copied: ids.length - 1, duplicates: 1, failed: [], trashed: a.moveItems ? ids.length : null };
    }
    case "query_items":
      return query(a.query);
    case "facet_counts":
      return facets(a.query);
    case "get_counts":
      return {
        all: live().length,
        unfiled: live().filter((i) => !folders.some((f) => inFolder(i.id, f.id))).length,
        untagged: live().filter((i) => !tags.some((t) => hasTag(i.id, t.id))).length,
        trash: items.length - live().length,
        favorites: live().filter((i) => i.favorite).length,
        pinned: live().filter((i) => i.pinnedAt !== null).length,
        tray: live().filter((i) => tray.has(i.id)).length,
        ...fontCounts(live()),
      };
    case "selection_info": {
      const ids: string[] = a.ids;
      return {
        tags: tags.map((t) => ({ ...t, count: ids.filter((i) => hasTag(i, t.id)).length })).filter((t) => t.count > 0),
        folders: folders
          .map((f) => ({ id: f.id, count: ids.filter((i) => inFolder(i, f.id)).length }))
          .filter((f) => f.count > 0),
      };
    }
    case "set_note":
      items.find((i) => i.id === a.id)!.note = a.note;
      return;
    case "rename_item":
      items.find((i) => i.id === a.id)!.name = a.name;
      return;
    case "trash_items":
      items.filter((i) => a.ids.includes(i.id)).forEach((i) => (i.deletedAt ??= Date.now()));
      return;
    case "restore_items":
      items.filter((i) => a.ids.includes(i.id)).forEach((i) => (i.deletedAt = null));
      return;
    case "delete_items":
    case "empty_trash": {
      const del = cmd === "empty_trash" ? items.filter((i) => i.deletedAt !== null).map((i) => i.id) : a.ids;
      for (const d of del) items.splice(items.findIndex((i) => i.id === d), 1);
      return;
    }
    case "reveal_item":
    case "open_items":
      return;
    case "set_rating":
      items.filter((i) => a.ids.includes(i.id)).forEach((i) => (i.rating = Math.min(5, a.rating)));
      return;
    case "set_favorite":
      items.filter((i) => a.ids.includes(i.id)).forEach((i) => (i.favorite = a.on));
      return;
    case "set_pinned":
      items.filter((i) => a.ids.includes(i.id)).forEach((i) => (i.pinnedAt = a.on ? (i.pinnedAt ?? Date.now()) : null));
      return;
    case "system_fonts":
      return systemFonts;
    case "reveal_system_font":
      return;
    case "font_info":
    case "font_faces": {
      const it = fontItem(a.id);
      const ja = it.fontScript === "ja";
      const latin = Array.from({ length: 94 }, (_, k) => 0x21 + k);
      const kana = Array.from({ length: 83 }, (_, k) => 0x3041 + k);
      const chars = ja ? [...latin, ...kana] : latin;
      const face = { glyphs: ja ? 17000 : 2500, charCount: chars.length, italic: false, designer: "Mock Type Foundry", version: "Version 2.004" };
      const faces =
        it.ext === "ttc"
          ? ["W3", "W6"].map((w) => ({ ...face, family: "ヒラギノ角ゴシック", style: w, fullName: `ヒラギノ角ゴシック ${w}`, weight: w === "W3" ? 300 : 600, axes: [], instances: [] }))
          : ja
            ? [{ ...face, family: it.fontFamily ?? "", style: it.name.split(/[-.]/)[1], fullName: it.name, weight: it.fontWeight ?? 400, axes: [], instances: [] }]
            : [{ ...face, family: it.fontFamily ?? "", style: "Regular", fullName: it.name, weight: 400, ...(it.ext === "woff2" ? { axes: [{ tag: "wght", name: "Weight", min: 100, default: 400, max: 900 }, { tag: "opsz", name: "Optical size", min: 14, default: 14, max: 32 }], instances: ["Thin", "ExtraLight", "Light", "Regular", "Medium", "SemiBold", "Bold", "ExtraBold", "Black"] } : { axes: [], instances: [] }) }];
      return cmd === "font_faces" ? faces : { faces, chars };
    }
    case "set_font_category": {
      const fonts = items.filter((i) => a.ids.includes(i.id));
      fonts.forEach((i) => (i.fontCategoryUser = a.category));
      return fonts.length;
    }
    case "font_list_preview": {
      const it = fontItem(a.id);
      return {
        sample: it.fontScript === "ja" ? "永遠の青い空 いろは アイウ Aa 123" : "The quick brown fox jumps over 0123",
        style: it.ext === "ttc" ? "W3" : (it.name.split(/[-.]/)[1] ?? "Regular"),
        faces: it.ext === "ttc" ? 2 : 1,
      };
    }
    case "font_data":
      // No font files in the browser mock: the viewer falls back to the system font.
      throw "モックではフォントを読み込めません";
    case "add_system_to_tray": {
      const fresh = systemFonts.filter((f) => a.ids.includes(f.id) && !tray.has(f.id));
      fresh.forEach((f) => {
        tray.set(f.id, ++traySeq);
        systemTrayNames.set(f.id, f.name);
      });
      return fresh.length;
    }
    case "system_tray": {
      const order = [...tray.entries()].sort((x, y) => x[1] - y[1]).map(([i]) => i);
      return { order, fonts: order.flatMap((i) => (systemTrayNames.has(i) ? [{ id: i, name: systemTrayNames.get(i)! }] : [])) };
    }
    case "library_font_ps_names":
      return [...new Set(items.flatMap((i) => (i.deletedAt === null && i.fontPsName ? [i.fontPsName] : [])))];
    case "add_to_tray": {
      const fresh = (a.ids as string[]).filter((i) => !tray.has(i) && items.some((x) => x.id === i));
      fresh.forEach((i) => tray.set(i, ++traySeq));
      return fresh.length;
    }
    case "remove_from_tray":
      a.ids.forEach((i: string) => {
        tray.delete(i);
        systemTrayNames.delete(i);
      });
      return;
    case "clear_tray": {
      const ids = [...tray.entries()].sort((x, y) => x[1] - y[1]).map(([i]) => i);
      tray.clear();
      systemTrayNames.clear();
      return ids;
    }
    case "reorder_tray": {
      const order = [...tray.entries()]
        .sort((x, y) => x[1] - y[1])
        .map(([i]) => i)
        .filter((i) => !a.ids.includes(i));
      const at = a.before ? order.indexOf(a.before) : -1;
      order.splice(at < 0 ? order.length : at, 0, ...a.ids.filter((i: string) => tray.has(i)));
      order.forEach((i, n) => tray.set(i, n + 1));
      return;
    }
    case "reveal_path":
    case "reveal_log":
      return;
    case "open_release_page":
      console.info(`[mock] ${cmd}`, a.version);
      return;
    case "copy_items":
    case "export_items":
      return a.ids.length;
    case "export_library": {
      const n = live().length;
      return { folder: `${a.dest}/Mock`, copied: n, total: n, failed: [], cancelled: false };
    }
    case "cancel_export":
      return null;
    case "index_fonts":
      return 0;
    case "supported_exts":
      return FONT_EXTS;
    case "import_paths":
    case "import_bytes":
      return { imported: 0, duplicates: 0, failed: ["mock backend: import is not available in the browser"] };
    case "list_folders":
      return folders.map((f) => ({ ...f, count: live().filter((i) => inFolder(i.id, f.id)).length }));
    case "place_folder":
      return placeFolder(a.id, a.parentId ?? null, a.before ?? null);
    case "shift_folder": {
      const f = folders.find((x) => x.id === a.id)!;
      reorderSiblings(f.parentId, (sibs) => {
        const from = sibs.findIndex((f) => f.id === a.id);
        const [f] = sibs.splice(from, 1);
        sibs.splice(Math.max(0, Math.min(sibs.length, from + a.by)), 0, f);
        return sibs;
      });
      return;
    }
    case "sort_folders_by_name":
      reorderSiblings(a.parentId ?? null, (sibs) => [...sibs].sort((x, y) => x.name.localeCompare(y.name)));
      return;
    case "list_smart_folders":
      return smartFolders.map((f) => ({ ...f, count: applyRule(live(), f.rule).length }));
    case "create_smart_folder": {
      const f = { id: id(), name: a.name, rule: a.rule, color: null };
      smartFolders.push(f);
      return f.id;
    }
    case "update_smart_folder": {
      const f = smartFolders.find((x) => x.id === a.id)!;
      if (a.name) f.name = a.name;
      if (a.rule) f.rule = a.rule;
      return;
    }
    case "delete_smart_folder":
      smartFolders.splice(smartFolders.findIndex((x) => x.id === a.id), 1);
      return;
    case "list_exts": {
      const m = new Map<string, number>();
      live().forEach((i) => m.set(ext(i.ext), (m.get(ext(i.ext)) ?? 0) + 1));
      return [...m.entries()].sort((x, y) => y[1] - x[1]);
    }
    case "create_folder": {
      const f = { id: id(), parentId: a.parentId ?? null, name: a.name, color: null };
      folders.push(f);
      return f.id;
    }
    case "rename_folder":
      folders.find((f) => f.id === a.id)!.name = a.name;
      return;
    case "delete_folder":
      removeFolder(a.id);
      return;
    case "move_folder":
      return placeFolder(a.id, a.parentId ?? null, null);
    case "move_to_folder":
      a.ids.forEach((i: string) => link(i, a.folderId));
      return;
    case "reorder_in_folder": {
      const order = [...itemFolders.entries()]
        .filter(([k]) => k.endsWith(`|${a.folderId}`))
        .sort((x, y) => x[1] - y[1])
        .map(([k]) => k.split("|")[0])
        .filter((id) => !a.ids.includes(id));
      const at = a.before ? order.indexOf(a.before) : -1;
      order.splice(at < 0 ? order.length : at, 0, ...a.ids);
      order.forEach((id, n) => itemFolders.set(`${id}|${a.folderId}`, n + 1));
      return;
    }
    case "remove_from_folder":
      a.ids.forEach((i: string) => itemFolders.delete(`${i}|${a.folderId}`));
      return;
    case "list_tags":
      return [...tags]
        .sort((x, y) => x.name.localeCompare(y.name))
        .map((t) => ({ ...t, count: live().filter((i) => hasTag(i.id, t.id)).length })) satisfies Tag[];
    case "create_tag": {
      const name = String(a.name).trim();
      if (!name) return null;
      const known = tags.find((x) => x.name.toLowerCase() === name.toLowerCase());
      const t = known ?? { id: ++tagSeq, name, color: null };
      if (!known) tags.push(t);
      return { ...t, count: live().filter((i) => hasTag(i.id, t.id)).length } satisfies Tag;
    }
    case "add_tags":
      addTags(a.ids, a.names);
      return;
    case "remove_tag":
      a.ids.forEach((i: string) => itemTags.delete(`${i}|${a.tagId}`));
      return;
    case "set_folder_color":
      folders.find((f) => f.id === a.id)!.color = a.color;
      return;
    case "set_smart_folder_color":
      smartFolders.find((f) => f.id === a.id)!.color = a.color;
      return;
    case "set_tag_color":
      tags.find((t) => t.id === a.id)!.color = a.color;
      return;
    case "rename_tag": {
      const t = tags.find((x) => x.id === a.id)!;
      const other = tags.find((x) => x.id !== a.id && x.name.toLowerCase() === a.name.trim().toLowerCase());
      if (other) {
        [...itemTags].filter((k) => k.endsWith(`|${t.id}`)).forEach((k) => {
          itemTags.delete(k);
          itemTags.add(`${k.split("|")[0]}|${other.id}`);
        });
        tags.splice(tags.indexOf(t), 1);
      } else t.name = a.name.trim();
      return;
    }
    case "delete_tag":
      tags.splice(tags.findIndex((t) => t.id === a.id), 1);
      [...itemTags].filter((k) => k.endsWith(`|${a.id}`)).forEach((k) => itemTags.delete(k));
      return;
    case "plugin:dialog|ask":
    case "plugin:dialog|confirm":
      return window.confirm(a.message);
    case "plugin:dialog|open":
    case "plugin:dialog|save":
      return null;
    default:
      console.warn("[mock] unhandled command", cmd, a);
      return null;
  }
}

export function installMockBackend() {
  seed();
  mockWindows("main");
  mockIPC((cmd, payload) => handle(cmd, payload), { shouldMockEvents: true });
  // Thumbnails are data: URLs already; pass them through untouched.
  (window as unknown as { __TAURI_INTERNALS__: { convertFileSrc: (p: string) => string } }).__TAURI_INTERNALS__.convertFileSrc = (p) => p;
  (window as unknown as { __MOCK_BACKEND__: boolean }).__MOCK_BACKEND__ = true;
  console.info("[mock] in-memory backend installed");
}
