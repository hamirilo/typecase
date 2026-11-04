// The mark tying the same font in the library and installed on this computer
// (docs/SYSTEM_FONTS.md): a library font that is installed here too, an
// installed font that is in the library. Matched by PostScript name.
import { Library, Monitor } from "lucide-react";
import { isSystemId, type Item } from "../../lib/api";
import { useFontLink, useFontLinks } from "./system";

/** The mark on a list row (`compact`: the icon alone, for the grid's tiles). */
export function FontLinkBadge({ item, compact = false }: { item: Item; compact?: boolean }) {
  const link = useFontLink(item);
  if (!link) return null;
  const installed = link === "installed";
  const Icon = installed ? Monitor : Library;
  const title = installed
    ? `この端末にも同じフォントがインストールされています（${item.fontPsName}）`
    : `同じフォントがライブラリにあります（${item.fontPsName}）`;
  return (
    <span
      title={title}
      className={`flex shrink-0 items-center gap-1 rounded text-sky-700 dark:text-sky-300 ${compact ? "" : "bg-sky-400/10 px-1.5 py-px"}`}
    >
      <Icon size={compact ? 12 : 11} />
      {!compact && (installed ? "インストール済み" : "ライブラリにある")}
    </span>
  );
}

/** The details panel's row: whether this computer has the library's font, or the library the installed one. */
export function FontLinkRow({ item }: { item: Item }) {
  const link = useFontLink(item);
  const system = isSystemId(item.id);
  // Not known yet (the installed fonts are still being read), or nothing to match by.
  const known = useFontLinks((s) => (system ? s.library : s.installed) !== null);
  if (!known || !item.fontPsName) return null;
  return (
    <>
      <dt className="text-dim">{system ? "ライブラリ" : "この端末"}</dt>
      <dd title={`PostScript 名：${item.fontPsName}`}>
        {system ? (link ? "同じフォントがある" : "無い") : link ? "インストール済み" : "インストールされていない"}
      </dd>
    </>
  );
}
