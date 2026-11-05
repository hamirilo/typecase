import {
  ChevronDown,
  ChevronRight,
  Folder as FolderIcon,
  FolderPlus,
  FolderSearch,
  Heart,
  Images,
  Inbox,
  Keyboard,
  Languages,
  Monitor,
  MoreHorizontal,
  Pin,
  Plus,
  SlidersHorizontal,
  Tag as TagIcon,
  Tags,
  Trash2,
  Type as TypeIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  confirmDeleteFolder,
  confirmDeleteSmartFolder,
  confirmDeleteTag,
  createFolder,
  createSmartFolder,
  emptyTrash,
  exportList,
  renameSmartFolder,
  shiftFolder,
  sortFoldersByName,
  transferList,
  trayList,
} from "../lib/actions";
import { api, FONT_CATEGORIES, FONT_SCRIPTS, type Folder, type Tag, type View } from "../lib/api";
import { SIDEBAR_ENTRIES } from "../lib/librarySettings";
import {
  activeConditions,
  isHidden,
  sidebarEntryLabel,
  sidebarHidden,
  sidebarScope,
  useStore,
  type ListSource,
} from "../store";
import { useMenu, type MenuItem } from "./ContextMenu";
import { LibrarySwitcher } from "./LibrarySwitcher";
import { startPointerDrag } from "./DragLayer";
import { SHORTCUT_HELP_KEY, useShortcutHelp } from "./ShortcutHelp";
import { colorHex } from "../lib/colors";
import { comboText } from "../lib/shortcuts";
import { composing } from "../lib/ime";
import { dragRegion } from "../lib/titleBar";

const collapsedKey = (root: string) => `collapsed:${root}`;
function loadCollapsed(root: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(collapsedKey(root)) ?? "[]"));
  } catch {
    return new Set();
  }
}
function saveCollapsed(root: string, c: Set<string>) {
  try {
    localStorage.setItem(collapsedKey(root), JSON.stringify([...c]));
  } catch {
    /* ignore */
  }
}

/**
 * "サイドバーから隠す" for an entry, in the settings in effect (the app's, or
 * the library's own); the toast says which.
 */
function hideItem(id: string): MenuItem {
  return {
    label: "サイドバーから隠す",
    onClick: () => {
      const s = useStore.getState();
      const scope = sidebarScope(s);
      const before = sidebarHidden(s, scope);
      s.setSidebarHidden([...before, id], scope);
      s.notify({
        title: `「${sidebarEntryLabel(id)}」をサイドバーから隠しました`,
        detail: scope === "app" ? "すべてのライブラリ（アプリ全体の設定）" : "このライブラリだけ",
        action: { label: "元に戻す", onClick: () => useStore.getState().setSidebarHidden(before, scope) },
      });
    },
  };
}

/** The same "contents of this list" actions for every list in the sidebar (docs/MENUS.md §3). */
function contentsMenu(source: ListSource, what = "中身"): MenuItem[] {
  return [
    { label: `${what}を書き出し…`, onClick: () => exportList(source) },
    ...(source.kind === "tray" ? [] : [{ label: "シェルフにすべて追加", onClick: () => trayList(source) }]),
    { label: "別のライブラリへ…", onClick: () => transferList(source) },
  ];
}

const sameView = (a: View, b: View) =>
  a.kind === b.kind && (!("id" in a) || ("id" in b && a.id === b.id));

/** Drop highlight + post-drop pulse for a sidebar row with `data-drop={dropId}`. */
function useDropState(dropId: string | undefined) {
  const over = useStore(
    (s) => dropId !== undefined && (s.drag !== null || s.fileDrag) && s.dropTarget === dropId,
  );
  const flash = useStore((s) => (dropId !== undefined && s.flash?.target === dropId ? s.flash.n : null));
  return { over, flash };
}

export function Row({
  active,
  dropId,
  depth = 0,
  icon,
  label,
  count,
  children,
  onContextMenu,
  ...rest
}: {
  active?: boolean;
  dropId?: string;
  depth?: number;
  icon: React.ReactNode;
  label: React.ReactNode;
  count?: number;
} & React.HTMLAttributes<HTMLDivElement>) {
  const { over, flash } = useDropState(dropId);
  // Folder reordering: a line above / below the row.
  const insert = useStore((s) =>
    dropId && s.drag && s.dropTarget?.startsWith(`pos:${dropId}:`) ? s.dropTarget.slice(-6) : null,
  );
  return (
    <div
      {...rest}
      onContextMenu={onContextMenu}
      data-drop={dropId}
      className={`group relative flex h-7 cursor-default items-center gap-1.5 rounded-md pr-2 transition-[background-color,transform,box-shadow] duration-150 ${
        over
          ? "scale-[1.03] bg-accent-fill text-white shadow-lg shadow-accent/30"
          : active
            ? "bg-accent/25 text-fg"
            : "hover:bg-ink/5"
      }`}
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      {flash !== null && (
        <span
          key={`pulse-${flash}`}
          className="pointer-events-none absolute inset-0 animate-drop-pulse rounded-md"
        />
      )}
      {insert && (
        <span
          className={`pointer-events-none absolute right-1 h-0.5 rounded-full bg-accent shadow-[0_0_6px] shadow-accent ${
            insert === "before" ? "-top-px" : "-bottom-px"
          }`}
          style={{ left: 4 + depth * 14 }}
        />
      )}
      {children}
      <span className={`shrink-0 ${over ? "text-white" : "text-dim"}`}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && (
        <span
          key={`count-${flash ?? ""}`}
          className={`text-xs tabular-nums ${over ? "text-white" : count === 0 ? "text-dim/50" : "text-dim"} ${flash !== null ? "animate-pop" : ""} ${
            onContextMenu ? "group-hover:hidden" : ""
          }`}
        >
          {count}
        </span>
      )}
      {/* The right-click menu, for those who don't right-click. */}
      {onContextMenu && (
        <button
          title="メニュー"
          aria-label="メニュー"
          className="-mr-1 hidden h-5 w-5 shrink-0 items-center justify-center rounded text-dim group-hover:flex hover:bg-ink/10 hover:text-fg"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onContextMenu(e as unknown as React.MouseEvent<HTMLDivElement>);
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      )}
    </div>
  );
}

function InlineEdit({ value, onDone }: { value: string; onDone: (v: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <input
      ref={ref}
      defaultValue={value}
      className="w-full rounded border border-accent bg-bg px-1 outline-none"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (composing(e)) return;
        if (e.key === "Enter") finish(e.currentTarget.value);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

function FolderTree() {
  const folders = useStore((s) => s.folders);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const run = useStore((s) => s.run);
  const dropTarget = useStore((s) => s.dropTarget);
  const drag = useStore((s) => s.drag);
  const root = useStore((s) => s.library?.root ?? "");
  const showMenu = useMenu((s) => s.show);
  const [collapsed, setCollapsedRaw] = useState<Set<string>>(() => loadCollapsed(root));
  const editing = useStore((s) => s.renamingFolder);
  const setEditing = useStore((s) => s.setRenamingFolder);
  const showSubfolders = useStore((s) => s.showSubfolders);
  const setShowSubfolders = useStore((s) => s.setShowSubfolders);
  const setCollapsed = (fn: (c: Set<string>) => Set<string>) =>
    setCollapsedRaw((c) => {
      const n = fn(c);
      saveCollapsed(root, n);
      return n;
    });

  useEffect(() => setCollapsedRaw(loadCollapsed(root)), [root]);

  // ⇧ / ⌘ + click picks several folders to drag together. The open folder
  // counts as picked; opening another one (a plain click) starts over.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const openFolder = view.kind === "folder" ? view.id : null;
  useEffect(() => {
    setPicked(new Set());
    anchor.current = openFolder;
  }, [openFolder, view.kind]);

  const children = useMemo(() => {
    const m = new Map<string | null, Folder[]>();
    for (const f of folders) {
      const k = f.parentId;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(f);
    }
    return m;
  }, [folders]);

  const create = (parentId: string | null) => createFolder(parentId);

  /** The folders as the sidebar shows them (inside closed ones left out). */
  const shown = (): string[] => {
    const out: string[] = [];
    const walk = (parent: string | null) =>
      (children.get(parent) ?? []).forEach((f) => {
        out.push(f.id);
        if (!collapsed.has(f.id)) walk(f.id);
      });
    walk(null);
    return out;
  };
  const pick = (id: string, range: boolean) => {
    const order = shown();
    const base = new Set([...picked, ...(openFolder ? [openFolder] : [])]);
    const a = anchor.current ? order.indexOf(anchor.current) : -1;
    const b = order.indexOf(id);
    if (range && a >= 0 && b >= 0) {
      setPicked(new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1)));
      return;
    }
    if (base.has(id)) base.delete(id);
    else base.add(id);
    anchor.current = id;
    setPicked(base);
  };
  /** What a drag from `id` carries: all picked ones if it is among them. */
  const dragIds = (id: string): string[] => {
    if (!picked.has(id)) return [id];
    return shown().filter((f) => picked.has(f));
  };

  // A folder being renamed (e.g. just created via ⌘⇧N) must be visible.
  useEffect(() => {
    if (!editing) return;
    const byId = new Map(folders.map((f) => [f.id, f]));
    const ancestors: string[] = [];
    for (let p = byId.get(editing)?.parentId; p; p = byId.get(p)?.parentId) ancestors.push(p);
    if (ancestors.some((a) => collapsed.has(a))) {
      setCollapsed((c) => new Set([...c].filter((x) => !ancestors.includes(x))));
    }
    requestAnimationFrame(() =>
      document
        .querySelector(`[data-drop="folder:${CSS.escape(editing)}"]`)
        ?.scrollIntoView({ block: "nearest" }),
    );
  }, [editing, folders]);

  // Hovering a collapsed folder while dragging opens it after a moment.
  useEffect(() => {
    if (!dropTarget?.startsWith("folder:")) return;
    const id = dropTarget.slice(7);
    if (!collapsed.has(id)) return;
    const t = setTimeout(() => setCollapsed((c) => new Set([...c].filter((x) => x !== id))), 600);
    return () => clearTimeout(t);
  }, [dropTarget, collapsed]);

  const toggle = (id: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const render = (parent: string | null, depth: number): React.ReactNode =>
    (children.get(parent) ?? []).map((f) => {
      const kids = children.has(f.id);
      const open = !collapsed.has(f.id);
      return (
        <div key={f.id}>
          <Row
            depth={depth}
            dropId={`folder:${f.id}`}
            active={picked.size ? picked.has(f.id) : sameView(view, { kind: "folder", id: f.id })}
            icon={<FolderIcon size={15} style={{ color: colorHex(f.color) }} fill={colorHex(f.color) ?? "none"} fillOpacity={0.3} />}
            label={
              editing === f.id ? (
                <InlineEdit
                  value={f.name}
                  onDone={(v) => {
                    setEditing(null);
                    if (v && v.trim() && v !== f.name) run(() => api.renameFolder(f.id, v));
                  }}
                />
              ) : (
                f.name
              )
            }
            count={f.count}
            onPointerDown={(e) => {
              if (e.button === 0 && (e.shiftKey || e.metaKey || e.ctrlKey)) {
                e.preventDefault(); // no text selection
                pick(f.id, e.shiftKey);
                return;
              }
              startPointerDrag(
                e,
                () => ({ kind: "folder", ids: dragIds(f.id) }),
                () => {
                  setPicked(new Set());
                  anchor.current = f.id;
                  setView({ kind: "folder", id: f.id });
                },
              );
            }}
            onDoubleClick={() => setEditing(f.id)}
            onContextMenu={(e) =>
              showMenu(e, [
                { label: "新しいサブフォルダ", onClick: () => create(f.id) },
                { label: "名前を変更", hint: "F2", onClick: () => setEditing(f.id) },
                { separator: true },
                ...contentsMenu({ kind: "folder", id: f.id }),
                { separator: true },
                { colors: { current: f.color, onPick: (c) => run(() => api.setFolderColor(f.id, c)) } },
                { separator: true },
                {
                  label: "並べ替え",
                  submenu: [
                    { label: "上へ", hint: comboText("Mod+["), onClick: () => shiftFolder(f.id, -1) },
                    { label: "下へ", hint: comboText("Mod+]"), onClick: () => shiftFolder(f.id, 1) },
                    ...(f.parentId
                      ? [{ label: "最上位へ移動", onClick: () => run(() => api.moveFolder(f.id, null)) }]
                      : []),
                    ...(kids
                      ? [{ label: "サブフォルダを名前順に", onClick: () => sortFoldersByName(f.id) }]
                      : []),
                  ],
                },
                {
                  label: "サブフォルダの内容を表示",
                  checked: showSubfolders,
                  onClick: () => {
                    setView({ kind: "folder", id: f.id });
                    setShowSubfolders(!showSubfolders);
                  },
                },
                { separator: true },
                { label: "削除", danger: true, onClick: () => confirmDeleteFolder(f.id, f.name) },
              ])
            }
          >
            <span
              className={`-ml-1 w-3.5 shrink-0 text-dim ${kids ? "" : "invisible"}`}
              onPointerDown={(e) => {
                e.stopPropagation();
                toggle(f.id);
              }}
            >
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
          </Row>
          {kids && open && render(f.id, depth + 1)}
        </div>
      );
    });

  const draggingNested =
    drag?.kind === "folder" && drag.ids.some((id) => folders.find((f) => f.id === id)?.parentId != null);

  return (
    <Section
      title="フォルダ"
      hideId="section:folders"
      forceOpen={editing !== null && folders.some((f) => f.id === editing)}
      keep={(() => {
        const open = view.kind === "folder" ? folders.find((f) => f.id === view.id) : undefined;
        return open ? (
          <Row
            active
            icon={<FolderIcon size={15} style={{ color: colorHex(open.color) }} fill={colorHex(open.color) ?? "none"} fillOpacity={0.3} />}
            label={open.name}
            count={open.count}
          />
        ) : null;
      })()}
      menu={[
        { label: "フォルダを作成", hint: "⌘⇧N", onClick: () => create(null) },
        { label: "最上位のフォルダを名前順に並べ替え", onClick: () => sortFoldersByName(null) },
      ]}
      action={
        <button title="フォルダを作成（⌘⇧N）" className="text-dim hover:text-fg" onClick={() => create(null)}>
          <FolderPlus size={15} />
        </button>
      }
    >
      {draggingNested && (
        <div
          data-drop="root"
          className={`mb-1 animate-slide-down rounded-md border border-dashed px-2 py-1.5 text-center text-xs transition-colors ${
            dropTarget === "root" ? "border-accent bg-accent-fill text-white" : "border-line text-dim"
          }`}
        >
          ここにドロップで最上位へ
        </div>
      )}
      {folders.length === 0 ? (
        <p className="px-2 py-1 text-xs text-dim">＋ でフォルダを作成</p>
      ) : (
        render(null, 0)
      )}
    </Section>
  );
}

/**
 * A titled block of the sidebar. Its heading folds it (remembered per library);
 * the heading's buttons (`action`, e.g. ＋) show while the pointer is over it.
 * With `hideId` it can be hidden from the heading's menu (after `menu`), and
 * renders nothing while hidden. Folded, it keeps showing `keep` (the open place),
 * so you still see where you are; `forceOpen` unfolds it (a row is being made).
 */
export function Section({
  title,
  action,
  hideId,
  menu = [],
  keep,
  forceOpen,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  hideId?: string;
  menu?: MenuItem[];
  keep?: React.ReactNode;
  forceOpen?: boolean;
  children: React.ReactNode;
}) {
  const hidden = useStore((s) => hideId !== undefined && isHidden(s, hideId));
  const showMenu = useMenu((s) => s.show);
  const root = useStore((s) => s.library?.root ?? "");
  const id = hideId ?? title;
  const [folded, setFolded] = useState(() => loadCollapsed(root).has(id));
  useEffect(() => setFolded(loadCollapsed(root).has(id)), [root, id]);
  if (hidden) return null;
  const toggle = () => {
    const c = loadCollapsed(root);
    if (c.has(id)) c.delete(id);
    else c.add(id);
    saveCollapsed(root, c);
    setFolded(c.has(id));
  };
  const items: MenuItem[] = hideId ? [...menu, ...(menu.length ? [{ separator: true } as const] : []), hideItem(hideId)] : menu;
  const closed = folded && !forceOpen;
  return (
    <div className="mt-4">
      <div
        onContextMenu={items.length ? (e) => showMenu(e, items) : undefined}
        className="group/head mb-1 flex items-center px-2 text-xs font-semibold tracking-wide text-dim"
      >
        <button
          aria-expanded={!closed}
          title={closed ? "開く" : "折りたたむ"}
          onClick={toggle}
          className="-ml-0.5 flex min-w-0 flex-1 items-center gap-0.5 rounded py-0.5 text-left hover:text-fg"
        >
          {closed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <span className="truncate">{title}</span>
        </button>
        {action && (
          <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/head:opacity-100 focus-within:opacity-100">
            {action}
          </span>
        )}
      </div>
      {closed ? keep : children}
    </div>
  );
}

function SmartFolderList() {
  const smartFolders = useStore((s) => s.smartFolders);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const editing = useStore((s) => s.renamingFolder);
  const setEditing = useStore((s) => s.setRenamingFolder);
  const startEditSmart = useStore((s) => s.startEditSmart);
  const run = useStore((s) => s.run);
  const hasConditions = useStore((s) => activeConditions(s) > 0);
  const showMenu = useMenu((s) => s.show);

  return (
    <Section
      title="スマートフォルダ"
      hideId="section:smart"
      forceOpen={editing !== null && smartFolders.some((f) => f.id === editing)}
      keep={(() => {
        const open = view.kind === "smart" ? smartFolders.find((f) => f.id === view.id) : undefined;
        return open ? (
          <Row active icon={<FolderSearch size={15} style={{ color: colorHex(open.color) }} />} label={open.name} count={open.count} />
        ) : null;
      })()}
      action={
        <button
          title={hasConditions ? "今の条件をスマートフォルダとして保存（⌘⇧⌥N）" : "スマートフォルダを作成（⌘⇧⌥N）"}
          className="text-dim hover:text-fg"
          onClick={() => createSmartFolder()}
        >
          <FolderPlus size={15} />
        </button>
      }
    >
      {smartFolders.length === 0 && (
        <p className="px-2 py-1 text-xs leading-relaxed text-dim">
          絞り込みの「条件を保存」で、当てはまるフォントが自動で集まります
        </p>
      )}
      {smartFolders.map((sf) => (
        <Row
          key={sf.id}
          active={sameView(view, { kind: "smart", id: sf.id })}
          icon={<FolderSearch size={15} style={{ color: colorHex(sf.color) }} />}
          label={
            editing === sf.id ? (
              <InlineEdit
                value={sf.name}
                onDone={(v) => {
                  setEditing(null);
                  if (v && v.trim() && v !== sf.name) renameSmartFolder(sf.id, v);
                }}
              />
            ) : (
              sf.name
            )
          }
          count={sf.count}
          onClick={() => setView({ kind: "smart", id: sf.id })}
          onDoubleClick={() => setEditing(sf.id)}
          onContextMenu={(e) =>
            showMenu(e, [
              { label: "条件を編集", onClick: () => startEditSmart(sf) },
              { label: "名前を変更", hint: "F2", onClick: () => setEditing(sf.id) },
              { separator: true },
              ...contentsMenu({ kind: "smart", id: sf.id }),
              { separator: true },
              { colors: { current: sf.color, onPick: (c) => run(() => api.setSmartFolderColor(sf.id, c)) } },
              { separator: true },
              { label: "削除", danger: true, onClick: () => confirmDeleteSmartFolder(sf.id, sf.name) },
            ])
          }
        />
      ))}
    </Section>
  );
}

/** Tags are places like folders (docs/NAVIGATION.md): a click opens the tag's items. */
function TagList() {
  const tags = useStore((s) => s.tags);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const run = useStore((s) => s.run);
  const showMenu = useMenu((s) => s.show);
  const [editing, setEditing] = useState<number | null>(null);
  const adding = useStore((s) => s.creatingTag);
  const setAdding = useStore((s) => s.setCreatingTag);

  // The ＋ makes an empty tag, then opens it (tags are otherwise made by tagging fonts).
  const create = async (name: string) => {
    const made: { tag: Tag | null } = { tag: null };
    const ok = await run(async () => {
      made.tag = await api.createTag(name);
    });
    if (ok && made.tag) setView({ kind: "tag", id: made.tag.id });
  };

  return (
    <Section
      title="タグ"
      hideId="section:tags"
      forceOpen={adding}
      action={
        <button title="タグを作成" aria-label="タグを作成" className="text-dim hover:text-fg" onClick={() => setAdding(true)}>
          <Plus size={15} />
        </button>
      }
      keep={(() => {
        const open = view.kind === "tag" ? tags.find((t) => t.id === view.id) : undefined;
        return open ? (
          <Row
            active
            icon={<TagIcon size={14} style={{ color: colorHex(open.color) }} fill={colorHex(open.color) ?? "none"} fillOpacity={0.3} />}
            label={open.name}
            count={open.count}
          />
        ) : null;
      })()}
    >
      {tags.length === 0 && !adding && <p className="px-2 py-1 text-xs text-dim">タグはまだありません</p>}
      {tags.map((t) => (
        <Row
          key={t.id}
          active={view.kind === "tag" && view.id === t.id}
          icon={<TagIcon size={14} style={{ color: colorHex(t.color) }} fill={colorHex(t.color) ?? "none"} fillOpacity={0.3} />}
          label={
            editing === t.id ? (
              <InlineEdit
                value={t.name}
                onDone={(v) => {
                  setEditing(null);
                  if (v && v.trim() && v !== t.name) run(() => api.renameTag(t.id, v));
                }}
              />
            ) : (
              t.name
            )
          }
          count={t.count}
          onClick={() => setView({ kind: "tag", id: t.id })}
          onDoubleClick={() => setEditing(t.id)}
          onContextMenu={(e) =>
            showMenu(e, [
              { label: "名前を変更", onClick: () => setEditing(t.id) },
              { separator: true },
              ...contentsMenu({ kind: "tag", id: t.id }, "このタグのフォント"),
              { separator: true },
              { colors: { current: t.color, onPick: (c) => run(() => api.setTagColor(t.id, c)) } },
              { separator: true },
              { label: "削除", danger: true, onClick: () => confirmDeleteTag(t.id, t.name) },
            ])
          }
        />
      ))}
      {adding && (
        <Row
          icon={<TagIcon size={14} />}
          label={
            <InlineEdit
              value=""
              onDone={(v) => {
                setAdding(false);
                if (v && v.trim()) create(v.trim());
              }}
            />
          }
        />
      )}
    </Section>
  );
}

/**
 * The writing systems and typeface styles of the library's fonts, opened as
 * places (docs/NAVIGATION.md). Only the ones that have fonts are listed.
 */
function FontPlaces({
  title,
  hideId,
  kind,
  values,
  counts,
  icon,
}: {
  title: string;
  hideId: string;
  kind: "fontScript" | "fontCategory";
  values: { key: string; label: string }[];
  counts: Record<string, number>;
  icon: React.ReactNode;
}) {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const rows = values
    .map((v) => ({ ...v, active: view.kind === kind && view.id === v.key, count: counts[v.key] ?? 0 }))
    .filter((v) => v.count > 0 || v.active)
    .map((v) => ({
      active: v.active,
      node: (
        <Row
          key={v.key}
          active={v.active}
          icon={icon}
          label={v.label}
          count={v.count}
          onClick={() => setView({ kind, id: v.key } as View)}
        />
      ),
    }));
  return (
    <Section title={title} hideId={hideId} keep={rows.filter((r) => r.active).map((r) => r.node)}>
      {rows.length === 0 && <p className="px-2 py-1 text-xs text-dim">フォントを取り込むとここに出ます</p>}
      {rows.map((r) => r.node)}
    </Section>
  );
}

/**
 * The top heading of the sidebar, "場所". Its menu (shown on hover) lists every
 * entry that can be hidden, checked while shown: the way back for hidden ones
 * (the same setting as 設定 → サイドバー, docs/SETTINGS.md).
 */
function PlacesHeading() {
  const showMenu = useMenu((s) => s.show);
  const hidden = useStore(useShallow((s) => sidebarHidden(s)));
  const scope = useStore((s) => sidebarScope(s));
  const setHidden = useStore((s) => s.setSidebarHidden);
  const open = (e: React.MouseEvent) =>
    showMenu(e, [
      { header: scope === "app" ? "表示するもの（すべてのライブラリ）" : "表示するもの（このライブラリだけ）" },
      ...SIDEBAR_ENTRIES.map((en) => ({
        label: en.label,
        checked: !hidden.includes(en.id),
        onClick: () => setHidden(hidden.includes(en.id) ? hidden.filter((x) => x !== en.id) : [...hidden, en.id], scope),
      })),
    ]);
  return (
    <div className="group/head mb-1 flex items-center px-2 text-xs font-semibold tracking-wide text-dim">
      <span className="flex-1 pl-3">場所</span>
      <span className="opacity-0 transition-opacity group-hover/head:opacity-100 focus-within:opacity-100">
        <button
          title="表示するもの"
          aria-label="サイドバーに表示するものを選ぶ"
          onClick={open}
          className="flex h-5 w-6 items-center justify-center rounded hover:bg-ink/10 hover:text-fg"
        >
          <SlidersHorizontal size={14} />
        </button>
      </span>
    </div>
  );
}

export function Sidebar() {
  const counts = useStore((s) => s.counts);
  const systemCount = useStore((s) => s.systemCount);
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const hidden = useStore(useShallow((s) => sidebarHidden(s)));
  const showMenu = useMenu((s) => s.show);

  type Entry = { view: View; label: string; icon: React.ReactNode; count?: number; dropId?: string; title?: string };
  // Places, top down (docs/NAVIGATION.md): what to look at, what is marked,
  // the tidying up (framed), then what was gathered (folders, smart folders, tags).
  const looks: Entry[] = [
    {
      view: { kind: "all" },
      label: "すべてのフォント",
      icon: <Images size={15} />,
      count: counts.all,
    },
    { view: { kind: "unfiled" }, label: "未分類", icon: <Inbox size={15} />, count: counts.unfiled },
    { view: { kind: "untagged" }, label: "タグなし", icon: <Tags size={15} />, count: counts.untagged },
    // Read only, not in the library (docs/SYSTEM_FONTS.md); counted once first listed.
    {
      view: { kind: "system" },
      label: "この端末のフォント",
      icon: <Monitor size={15} />,
      count: systemCount ?? undefined,
      title: "この端末にインストールされているフォント（読み取り専用。ライブラリには入りません）",
    },
  ];
  const marks: Entry[] = [
    { view: { kind: "favorites" }, label: "お気に入り", icon: <Heart size={15} />, count: counts.favorites },
    { view: { kind: "pinned" }, label: "ピン留め", icon: <Pin size={15} />, count: counts.pinned },
    // The shelf is a tab of the details panel (Shelf.tsx), not a place to go.
  ];
  const tidying: Entry[] = [
    { view: { kind: "trash" }, label: "ゴミ箱", icon: <Trash2 size={15} />, count: counts.trash },
  ];

  const shown = (list: Entry[]) => list.filter((e) => !hidden.includes(e.view.kind));

  // "すべて" and "ゴミ箱" always stay (see SIDEBAR_ENTRIES).
  const hideable = (v: View) => v.kind !== "all" && v.kind !== "trash";
  const menuOf = (v: View): MenuItem[] =>
    v.kind === "trash"
      ? [{ label: "ゴミ箱を空にする", danger: true, onClick: emptyTrash }]
      : [];

  const row = (s: Entry) => (
    <Row
      key={s.view.kind}
      active={sameView(view, s.view)}
      icon={s.icon}
      label={s.label}
      count={s.count}
      dropId={s.dropId}
      title={s.title}
      onClick={() => setView(s.view)}
      onContextMenu={
        // "すべて" has nothing to offer (no "…" either).
        hideable(s.view) || menuOf(s.view).length
          ? (e) => {
              const items = menuOf(s.view);
              if (hideable(s.view))
                items.push(...(items.length ? [{ separator: true } as const] : []), hideItem(s.view.kind));
              showMenu(e, items);
            }
          : undefined
      }
    />
  );

  return (
    <aside className="vibrant flex shrink-0 flex-col border-r border-line bg-panel" style={{ width: sidebarWidth }}>
      {/* macOS: the window buttons' row, which also moves the window. */}
      <div {...dragRegion()} className="shrink-0" style={{ height: "var(--titlebar)" }} />
      {/* The library is switched seldom: at the bottom. */}
      <div className="h-2 shrink-0" />
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <PlacesHeading />
        {shown(looks).map(row)}
        {shown(marks).length > 0 && <div className="h-2" />}
        {shown(marks).map(row)}
        <div className="mt-2">{shown(tidying).map(row)}</div>
        <FontPlaces
          title="言語"
          hideId="section:scripts"
          kind="fontScript"
          values={FONT_SCRIPTS}
          counts={counts.fontScripts}
          icon={<Languages size={15} />}
        />
        <FontPlaces
          title="書体"
          hideId="section:categories"
          kind="fontCategory"
          values={FONT_CATEGORIES}
          counts={counts.fontCategories}
          icon={<TypeIcon size={15} />}
        />
        <FolderTree />
        <SmartFolderList />
        <TagList />
      </nav>
      <button
        onClick={() => useShortcutHelp.getState().setOpen(true)}
        className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-2 text-xs text-dim hover:bg-ink/5 hover:text-fg"
      >
        <Keyboard size={14} />
        ショートカット一覧
        <span className="ml-auto tabular-nums">{SHORTCUT_HELP_KEY}</span>
      </button>
      <LibrarySwitcher />
    </aside>
  );
}
