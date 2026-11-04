// A line of text in a font, marking the characters the font doesn't have
// (the font viewer and the specimen layout).
import type { CSSProperties } from "react";

/** Spaces, joiners and variation selectors: never "missing", whatever the font maps. */
export const neutral = (c: number) =>
  c <= 0x20 ||
  (c >= 0x200b && c <= 0x200d) ||
  (c >= 0xfe00 && c <= 0xfe0f) ||
  (c >= 0xe0100 && c <= 0xe01ef) ||
  /\s/u.test(String.fromCodePoint(c));

/**
 * `text` in the font. Characters the font doesn't have would silently come
 * out in a system font, so they are drawn in red with a dotted underline.
 */
export function Sample({
  text,
  has,
  style,
  className,
}: {
  text: string;
  /** Characters the font has; null while not known (shown as is). */
  has: Set<number> | null;
  style: CSSProperties;
  className?: string;
}) {
  if (!has) return <span style={style} className={className}>{text}</span>;
  const runs: { ok: boolean; s: string }[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    const ok = neutral(c) ? (runs.at(-1)?.ok ?? true) : has.has(c);
    if (runs.at(-1)?.ok === ok) runs.at(-1)!.s += ch;
    else runs.push({ ok, s: ch });
  }
  return (
    <span style={style} className={className}>
      {runs.map((r, i) =>
        r.ok ? (
          r.s
        ) : (
          <span
            key={i}
            title="このフォントに無い文字（システムのフォントで表示）"
            className="text-red-700 dark:text-red-300 underline decoration-red-400/70 decoration-dotted"
            style={{ fontFamily: "sans-serif" }}
          >
            {r.s}
          </span>
        ),
      )}
    </span>
  );
}

/**
 * The font lacks more than half of `text` (spaces aside): it would come out
 * mostly in a system font, e.g. Japanese text in an English font.
 */
export function mostlyMissing(text: string, has: Set<number> | null): boolean {
  if (!has) return false;
  let total = 0;
  let missing = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (neutral(c)) continue;
    total++;
    if (!has.has(c)) missing++;
  }
  return missing * 2 > total;
}

/** How many characters of `text` the font lacks. */
export function countMissing(text: string, has: Set<number> | null): number {
  if (!has) return 0;
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (!neutral(c) && !has.has(c)) n++;
  }
  return n;
}
