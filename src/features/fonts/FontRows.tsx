// Rows of the list for fonts: the specimen layout's row and the font grid's
// tile. All draw the sample in
// the font itself, loaded only while the row is on screen (see loader.ts).
import { ChevronRight, Heart, Layers, Pin } from "lucide-react";
import { memo, useEffect, useState } from "react";
// Grid supplies the cell plumbing and uses these rows: the import cycle is
// fine because everything is used at render time, not at load.
import { onItemPointerDown, rowSelection, showItemMenu, Stars, type CellProps } from "../../components/Grid";
import { ChangePulse } from "../../components/ActionHud";
import { toggleTray } from "../../lib/actions";
import { rowIds } from "../../lib/grouping";
import {
  fontCategoryLabel,
  fontCategoryOf,
  fontFeatureLabel,
  fontScriptLabel,
  isSystemId,
  type Item,
} from "../../lib/api";
import { useStore } from "../../store";
import { type FontListPreview } from "./api";
import { FontLinkBadge } from "./FontLink";
import { fontChars, fontPreview, holdFont, loadFont } from "./loader";
import { mostlyMissing, Sample } from "./Sample";

/** Loads the font and its sample line for a row; `failed` when either can't be had. */
function useFontRow(id: string) {
  const [family, setFamily] = useState<string | null>(null);
  const [preview, setPreview] = useState<FontListPreview | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setFamily(null);
    setPreview(null);
    setFailed(false);
    fontPreview(id)
      .then((p) => live && setPreview(p))
      .catch(() => live && setFailed(true));
    const release = holdFont(id);
    loadFont(id)
      .then((f) => live && setFamily(f))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      release();
    };
  }, [id]);
  const style = [preview?.style, preview && preview.faces > 1 ? `ほか ${preview.faces - 1} 個` : ""]
    .filter(Boolean)
    .join(" · ");
  return { family, preview, failed, style };
}

/**
 * The text a font shows: the typed specimen text, else (or when the font
 * lacks most of it and the fallback is on) its own sample. `has` marks the
 * characters it lacks; null while not known or not needed.
 */
function useSampleText(id: string, own: string | undefined) {
  const text = useStore((s) => s.specimenText);
  const fallback = useStore((s) => s.specimenFallback);
  const [has, setHas] = useState<Set<number> | null>(null);
  // The characters are only needed to check typed text.
  const typed = text.trim() !== "";
  useEffect(() => {
    if (!typed) return;
    let live = true;
    setHas(null);
    fontChars(id)
      .then((c) => live && setHas(c))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id, typed]);
  // Mostly red text in a system font says little about the font: its own sample instead.
  const swapped = typed && fallback && own !== undefined && mostlyMissing(text, has);
  const typedShown = typed && !swapped;
  return { text: typedShown ? text : (own ?? ""), has: typedShown ? has : null, swapped };
}

/** "44 スタイル" on a family row, nothing on a single font. */
function FamilyCount({ item }: { item: Item }) {
  if (!item.familyIds || item.familyIds.length < 2) return null;
  return (
    <span className="shrink-0 rounded bg-accent/15 px-1.5 py-px text-[11px] text-accent" title="このファミリーのスタイル数。操作は全部に効きます">
      {item.familyIds.length} スタイル
    </span>
  );
}

/**
 * Puts the row's font (a family: its regular) on the shelf or takes it off.
 * Shown on hover, and always while on the shelf.
 */
function ShelfButton({ item, className = "" }: { item: Item; className?: string }) {
  const on = useStore((s) => s.shelf.some((i) => i.id === item.id));
  return (
    <button
      title={on ? "シェルフから外す（B）" : "シェルフに追加（B）"}
      aria-pressed={on}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={() => void toggleTray(rowIds([item]))}
      className={`items-center justify-center rounded ${
        on ? "flex text-emerald-600 dark:text-emerald-400" : "hidden text-dim group-hover:flex hover:text-fg"
      } ${className}`}
    >
      <Layers size={13} />
    </button>
  );
}

/** ▸ / ▾ of a family row; the same room is kept on other rows so the names line up. */
function FamilyToggle({ item }: { item: Item }) {
  const open = useStore((s) => !!item.fontFamily && s.openFamilies.has(item.fontFamily));
  if (!item.familyIds || item.familyIds.length < 2 || !item.fontFamily)
    return <span className="w-4 shrink-0" aria-hidden />;
  const family = item.fontFamily;
  return (
    <button
      title={open ? "太さ違いを閉じる" : `太さ違いを開く（${item.familyIds.length} スタイル）`}
      aria-expanded={open}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={() => useStore.getState().toggleFamily(family)}
      className="flex h-4 w-4 shrink-0 items-center justify-center self-center rounded text-dim hover:bg-ink/10 hover:text-fg"
    >
      <ChevronRight size={13} className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
    </button>
  );
}

/**
 * Specimen layout: a font family as a row with its name and a sample line at
 * the chosen size, in the text typed above the list (or the font's own
 * sample). Characters the font lacks are marked; a font lacking most of them
 * shows its own sample instead (unless turned off in the pattern menu).
 * A family's opened styles (`familyMember`) follow it, indented.
 */
export const SpecimenRow = memo(function SpecimenRow(props: CellProps) {
  const { item, index, selected, focused, dimmed, width, height, reorderable, insert, flags } = props;
  const size = useStore((s) => s.specimenSize);
  const { family, preview, failed, style } = useFontRow(item.id);
  const sample = useSampleText(item.id, preview?.sample);
  const category = fontCategoryOf(item);
  const member = !!item.familyMember;
  return (
    <div
      className={`group relative flex flex-col justify-center gap-1 overflow-hidden rounded-md border-b border-line/60 px-3 transition-opacity duration-200 ${rowSelection(
        selected,
        focused,
      )} ${dimmed ? "opacity-35" : ""} ${member ? "pl-12" : ""}`}
      style={{ width, height }}
      onPointerDown={(e) => onItemPointerDown(e, item, index)}
      onDoubleClick={() => useStore.getState().openViewer(index)}
      onContextMenu={(e) => showItemMenu(e, item, index)}
      data-drop={reorderable ? `item:${item.id}` : undefined}
      data-axis="y"
    >
      <ChangePulse id={item.id} className="rounded-md" />
      <div className="flex min-w-0 items-baseline gap-2 text-xs">
        {!member && <FamilyToggle item={item} />}
        {member ? (
          <span className="truncate text-[13px]">{style || item.name}</span>
        ) : (
          <>
            <span className="truncate text-[13px] font-medium">{item.fontFamily || item.name}</span>
            <FamilyCount item={item} />
            <span className="shrink-0 text-dim">{style}</span>
          </>
        )}
        <span className="min-w-0 truncate text-dim/70">{item.name}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-dim">
          {sample.swapped && (
            <span
              className="rounded bg-accent/15 px-1.5 py-px text-accent"
              title="入力した文字の半分以上がこのフォントに無いため、このフォントの見本で表示しています（「パターン」のメニューで切り替え）"
            >
              {item.fontScript === "latin" ? "欧文見本" : "フォントの見本"}
            </span>
          )}
          <FontLinkBadge item={item} />
          {/* Installed fonts have no flags, but go on the shelf to be compared. */}
          {(flags || isSystemId(item.id)) && <ShelfButton item={item} className="h-4 w-4" />}
          {flags && item.pinnedAt !== null && <Pin size={11} className="text-accent" fill="currentColor" />}
          {flags && item.favorite && <Heart size={11} className="text-pink-600 dark:text-pink-400" fill="currentColor" />}
          {item.rating > 0 && <Stars n={item.rating} />}
          {!member && item.fontScript && (
            <span className="rounded bg-ink/8 px-1.5 py-px">{fontScriptLabel(item.fontScript)}</span>
          )}
          {!member && (
            <span
              className={`rounded px-1.5 py-px ${category === "none" ? "text-dim/70" : "bg-ink/8"}`}
              title={item.fontCategoryUser ? "手で設定した書体" : "自動で判定した書体（詳細パネルで変更できます）"}
            >
              {fontCategoryLabel(category)}
              {item.fontCategoryUser && " ✎"}
            </span>
          )}
          {!member &&
            item.fontFeatures.map((k) => (
              <span key={k} className="rounded bg-ink/8 px-1.5 py-px">
                {fontFeatureLabel(k)}
              </span>
            ))}
          <span className="uppercase">{item.ext}</span>
        </span>
      </div>
      {failed ? (
        <span className={`text-dim ${member ? "" : "pl-6"}`}>見本を表示できません</span>
      ) : (
        <Sample
          text={sample.text}
          has={sample.has}
          style={{ fontFamily: family ? `"${family}"` : undefined, fontSize: size, lineHeight: 1.15 }}
          className={`block truncate whitespace-pre transition-opacity duration-200 ${member ? "" : "pl-6"} ${
            family && preview ? "opacity-100" : "opacity-0"
          }`}
        />
      )}
      {insert && (
        <span
          className={`pointer-events-none absolute right-2 left-2 h-0.5 rounded-full bg-accent shadow-[0_0_6px] shadow-accent ${
            insert === "before" ? "-top-px" : "-bottom-px"
          }`}
        />
      )}
    </div>
  );
});

/** What a tile shows with no text typed: a Japanese font its kana and kanji, a Latin one its letters. */
const tileSample = (item: Item) => (item.fontScript === "latin" ? "Aa" : "あ永A");

/**
 * Font grid: one tile per family, the typed specimen text (or a few
 * characters) drawn in the font, the family's name and its number of styles
 * below. Families don't open here.
 */
export const FontTile = memo(function FontTile(props: CellProps) {
  const { item, index, selected, focused, dimmed, width, height, label, info, reorderable, insert, flags } = props;
  const { family, preview, failed } = useFontRow(item.id);
  const typed = useStore((s) => s.specimenText.trim() !== "");
  const sample = useSampleText(item.id, preview ? tileSample(item) : undefined);
  // A few characters fill the tile; longer typed text gets smaller and wraps in up to three lines.
  const length = !typed || sample.swapped ? 3 : [...sample.text].length;
  const scale = length <= 4 ? 0.26 : length <= 10 ? 0.18 : 0.12;
  return (
    <div
      className={`group relative flex flex-col items-center transition-[opacity,transform] duration-200 ${
        dimmed ? "scale-95 opacity-35" : ""
      }`}
      style={{ width }}
      onPointerDown={(e) => onItemPointerDown(e, item, index)}
      onDoubleClick={() => useStore.getState().openViewer(index)}
      onContextMenu={(e) => showItemMenu(e, item, index)}
      data-drop={reorderable ? `item:${item.id}` : undefined}
    >
      <div
        className={`relative flex items-center justify-center overflow-hidden rounded-lg bg-raised px-2 transition-shadow duration-150 ${
          selected ? "sel-ring" : focused ? "" : "hover:ring-2 hover:ring-ink/15"
        } ${focused ? "focus-ring" : ""}`}
        style={{ width, height }}
      >
        {failed ? (
          <span className="text-xs text-dim">見本を表示できません</span>
        ) : (
          <Sample
            text={sample.text}
            has={sample.has}
            style={{
              fontFamily: family ? `"${family}"` : undefined,
              fontSize: Math.round(width * scale),
              lineHeight: 1.2,
            }}
            className={`line-clamp-3 text-center break-all transition-opacity duration-200 ${
              family && preview ? "opacity-100" : "opacity-0"
            }`}
          />
        )}
        {flags && (item.pinnedAt !== null || item.favorite) && (
          <span className="pointer-events-none absolute top-1.5 right-1.5 flex gap-1">
            {item.pinnedAt !== null && <Pin size={11} className="text-accent" fill="currentColor" />}
            {item.favorite && <Heart size={11} className="text-pink-600 dark:text-pink-400" fill="currentColor" />}
          </span>
        )}
        {(flags || isSystemId(item.id)) && (
          <ShelfButton item={item} className="absolute top-1 left-1 h-6 w-6 bg-black/45" />
        )}
        <span className="pointer-events-none absolute bottom-1.5 left-1.5">
          <FontLinkBadge item={item} compact />
        </span>
        <ChangePulse id={item.id} />
      </div>
      {insert && (
        <span
          className="pointer-events-none absolute top-0 w-1 animate-fade-in rounded-full bg-accent shadow-[0_0_8px] shadow-accent"
          style={{ height, [insert === "before" ? "left" : "right"]: -8 }}
        />
      )}
      {label > 0 && (
        <div className="mt-1.5 w-full text-center leading-[15px]">
          {info.name && (
            <div className="flex items-center justify-center gap-1.5 text-xs">
              <span className={`truncate ${selected ? "text-fg" : ""}`} title={item.name}>
                {item.fontFamily || item.name}
              </span>
              <FamilyCount item={item} />
            </div>
          )}
          {(info.rating || info.meta) && (
            <div className="flex items-center justify-center gap-1.5 overflow-hidden text-[11px] whitespace-nowrap text-dim">
              {info.rating && item.rating > 0 && <Stars n={item.rating} />}
              {info.meta && <span className="uppercase">{item.ext}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
