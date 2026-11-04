import { useEffect, useMemo, useState } from "react";
import type { Item } from "../../lib/api";
import { fontApi, type FontInfo } from "./api";
import { countMissing, Sample } from "./Sample";
import { Slider } from "../../components/Slider";

const SAMPLE_JA = "あのイーハトーヴォのすきとおった風、夏でも底に冷たさをもつ青いそら";
const SAMPLE_EN = "The quick brown fox jumps over the lazy dog 0123456789";
/** Smaller sizes shown under the main sample. */
const WATERFALL = [12, 16, 24, 36];
/** The character list shows this many at most (more would make the page heavy). */
const MAX_LISTED = 3000;

/**
 * Viewer body for a font: sample text at any size, the fonts in a collection,
 * and the characters it covers. The font is loaded with `new FontFace()` from
 * data the backend unpacks (WOFF / WOFF2, one font out of a TTC).
 */
export function FontView({ item }: { item: Item }) {
  const [face, setFace] = useState(0);
  const [info, setInfo] = useState<FontInfo | null>(null);
  const [family, setFamily] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [text, setText] = useState("");
  const [size, setSize] = useState(64);

  useEffect(() => setFace(0), [item.id]);

  useEffect(() => {
    let alive = true;
    let loaded: FontFace | null = null;
    setInfo(null);
    setFamily(null);
    setFailed(false);
    fontApi
      .info(item.id, face)
      .then((i) => alive && setInfo(i))
      .catch(() => alive && setFailed(true));
    // A unique name per item and face, so fonts with the same family don't clash.
    const name = `il-font-${item.id}-${face}`;
    fontApi
      .data(item.id, face)
      .then((data) => new FontFace(name, data).load())
      .then((f) => {
        if (!alive) return;
        loaded = f;
        document.fonts.add(f);
        setFamily(name);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (loaded) document.fonts.delete(loaded);
    };
  }, [item.id, face]);

  const current = info?.faces[face];
  const has = useMemo(() => (info ? new Set(info.chars) : null), [info]);
  const hasKana = has?.has(0x3042) ?? false; // "あ"
  const sample = text || (hasKana ? SAMPLE_JA : SAMPLE_EN);
  const missing = countMissing(sample, has);
  const style = { fontFamily: family ? `"${family}", sans-serif` : "sans-serif" };
  const label = "mb-2 text-[11px] font-semibold text-ink/45";

  return (
    <div className="absolute inset-0 overflow-y-auto px-10 py-6 text-ink/90">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
          <div className="min-w-0">
            <div className="truncate text-xl font-semibold">{current?.family || item.name}</div>
            <div className="text-sm text-ink/55">
              {current?.style}
              {current && ` · ${current.glyphs.toLocaleString()} グリフ`}
              {info && ` · ${info.chars.length.toLocaleString()} 文字`}
            </div>
          </div>
          {info && info.faces.length > 1 && (
            <select
              value={face}
              onChange={(e) => setFace(Number(e.target.value))}
              className="ml-auto rounded-md border border-ink/15 bg-black/40 px-2 py-1 text-sm outline-none focus:border-accent"
              title={`このファイルには ${info.faces.length} 個のフォントが入っています`}
            >
              {info.faces.map((f, i) => (
                <option key={i} value={i}>
                  {f.fullName || `${f.family} ${f.style}`}
                </option>
              ))}
            </select>
          )}
        </div>

        {failed && (
          <p className="rounded-md bg-red-500/15 px-3 py-2 text-sm text-red-800 dark:text-red-200">
            フォントを読み込めませんでした。表示はシステムのフォントです。
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="テキストを入力して試す"
            className="min-w-60 flex-1 rounded-md border border-ink/15 bg-black/40 px-3 py-1.5 text-sm outline-none focus:border-accent"
          />
          <label className="flex items-center gap-2 text-xs text-ink/55">
            <Slider
              min={12}
              max={200}
              value={size}
              onChange={(e) => setSize(Number(e.target.value))}
              className="w-40"
            />
            <span className="w-12 tabular-nums">{size}px</span>
          </label>
        </div>

        <Sample text={sample} has={has} style={{ ...style, fontSize: size }} className="block leading-tight break-words" />

        {missing > 0 && (
          <p className="-mt-3 text-xs text-red-700 dark:text-red-300/90">
            赤い {missing.toLocaleString()} 字はこのフォントに無いため、システムのフォントで表示しています
          </p>
        )}

        <div className="flex flex-col gap-2 border-t border-ink/10 pt-4">
          {WATERFALL.map((px) => (
            <div key={px} className="flex items-baseline gap-3">
              <span className="w-10 shrink-0 text-right text-[11px] text-ink/35 tabular-nums">{px}</span>
              <Sample text={sample} has={has} style={{ ...style, fontSize: px }} className="truncate" />
            </div>
          ))}
        </div>

        {info && (
          <div>
            <div className={label}>
              文字（{info.chars.length > MAX_LISTED
                ? `最初の ${MAX_LISTED.toLocaleString()} 字 / 全 ${info.chars.length.toLocaleString()} 字`
                : `${info.chars.length.toLocaleString()} 字`}）
            </div>
            <div
              style={style}
              className="grid grid-cols-[repeat(auto-fill,minmax(44px,1fr))] gap-px overflow-hidden rounded-md bg-ink/10"
            >
              {info.chars.slice(0, MAX_LISTED).map((c) => {
                const ch = String.fromCodePoint(c);
                return (
                  <div
                    key={c}
                    title={`U+${c.toString(16).toUpperCase().padStart(4, "0")}`}
                    className="flex h-11 items-center justify-center bg-field text-xl hover:bg-ink/10"
                  >
                    {ch}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
