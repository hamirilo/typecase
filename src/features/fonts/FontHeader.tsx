// The top of the details panel for one font: the font itself in a specimen
// card, then its family and style (the file name comes after, it is only a file).
import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { Item } from "../../lib/api";
import { fontPreview, holdFont, loadFont } from "./loader";

/** "Aa" and a line of the font, drawn in the font; the rendered thumbnail while it loads or fails. */
export function FontSpecimenCard({ item, onOpen }: { item: Item; onOpen?: () => void }) {
  const id = item.id;
  const [family, setFamily] = useState<string | null>(null);
  const [sample, setSample] = useState("ABC abc 123");
  useEffect(() => {
    let live = true;
    setFamily(null);
    const release = holdFont(id);
    loadFont(id)
      .then((f) => live && setFamily(f))
      .catch(() => {});
    fontPreview(id)
      .then((p) => live && p.sample && setSample(p.sample))
      .catch(() => {});
    return () => {
      live = false;
      release();
    };
  }, [id]);

  return (
    <div
      className="flex aspect-[4/3] flex-col items-center justify-center gap-2 overflow-hidden rounded-lg bg-white px-3 text-black"
      onDoubleClick={onOpen}
      title="ダブルクリックでビューアを開く"
    >
      {family ? (
        <>
          <div style={{ fontFamily: `"${family}"`, fontSize: 72, lineHeight: 1 }}>Aa</div>
          <div
            className="max-w-full truncate"
            style={{ fontFamily: `"${family}"`, fontSize: 18 }}
          >
            {sample}
          </div>
        </>
      ) : (
        <img
          src={convertFileSrc(item.thumbPath)}
          className="max-h-full max-w-full object-contain"
          draggable={false}
          alt=""
        />
      )}
    </div>
  );
}

/** Family name and style as the heading; weight and format as the facts under it. */
export function FontTitle({ item }: { item: Item }) {
  const [style, setStyle] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setStyle(null);
    fontPreview(item.id)
      .then((p) => live && setStyle(p.style))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [item.id]);
  return (
    <div className="mt-3 px-1">
      <div className="break-words text-base font-semibold leading-snug">{item.fontFamily ?? item.name}</div>
      {style && <div className="text-xs text-dim">{style}</div>}
    </div>
  );
}

/**
 * 複数選択のプレビュー：1 件のときと同じ大きさの枠に、最初の 4 件の「Aa」をそれぞれの
 * フォントで並べる（5 件目からは「+N」）。読めないあいだはサムネイル。
 */
export function FontSpecimenGrid({ items, count }: { items: Item[]; count: number }) {
  return (
    <div className="relative grid aspect-[4/3] grid-cols-2 grid-rows-2 gap-0.5 overflow-hidden rounded-lg bg-line">
      {items.slice(0, 4).map((i) => (
        <MiniCell key={i.id} item={i} />
      ))}
      {count > 4 && (
        <span className="absolute right-1.5 bottom-1.5 rounded-full bg-black/60 px-2 text-[11px] font-bold text-white tabular-nums">
          +{count - 4}
        </span>
      )}
    </div>
  );
}

function MiniCell({ item }: { item: Item }) {
  const id = item.id;
  const [family, setFamily] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setFamily(null);
    const release = holdFont(id);
    loadFont(id)
      .then((f) => live && setFamily(f))
      .catch(() => {});
    return () => {
      live = false;
      release();
    };
  }, [id]);
  return (
    <div className="flex min-h-0 items-center justify-center overflow-hidden bg-white text-black" title={item.fontFamily ?? item.name}>
      {family ? (
        <span style={{ fontFamily: `"${family}"`, fontSize: 36, lineHeight: 1 }}>Aa</span>
      ) : (
        <img src={convertFileSrc(item.thumbPath)} className="max-h-full max-w-full object-contain" draggable={false} alt="" />
      )}
    </div>
  );
}
