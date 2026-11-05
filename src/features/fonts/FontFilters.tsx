// The fonts' conditions in the filter row (docs/NAVIGATION.md): writing
// system, typeface style, weight and features. Within one the values picked
// are "any of"; with the other conditions, "all of". The counts are with the
// other conditions on (`useFacets`).
// FilterRow supplies the button and menu chrome and renders these: the import
// cycle is fine because everything is used at render time, not at load.
import { Fragment } from "react";
import { Option, Pill, toggled, useFacets, useNotForSystem, type CondProps } from "../../components/FilterRow";
import {
  FONT_AXES,
  FONT_CATEGORIES,
  FONT_FEATURES,
  FONT_SCRIPTS,
  FONT_STYLES,
  FONT_WEIGHTS,
  type Facets,
  type Filter,
} from "../../lib/api";
import { CLEARED, useStore, type ConditionKey } from "../../store";

type FontKey = "fontScripts" | "fontCategories" | "fontWeights" | "fontStyles" | "fontFeatures" | "fontAxes";

const CONDITIONS: {
  key: FontKey & ConditionKey;
  label: string;
  values: { key: string; label: string; names?: string }[];
}[] = [
  { key: "fontScripts", label: "言語", values: FONT_SCRIPTS },
  { key: "fontCategories", label: "書体", values: FONT_CATEGORIES },
  { key: "fontWeights", label: "太さ", values: FONT_WEIGHTS },
  { key: "fontStyles", label: "スタイル数", values: FONT_STYLES },
  { key: "fontFeatures", label: "特徴", values: FONT_FEATURES },
  { key: "fontAxes", label: "軸", values: FONT_AXES },
];

/**
 * 収録文字: only fonts that map every character typed here. The characters
 * can be taken from the specimen text. It asks the characters each library
 * font was read to map, so it isn't there for the installed fonts.
 */
function CharsCondition({ cond, locked, onLocked }: CondProps) {
  const setFilter = useStore((s) => s.setFilter);
  const specimen = useStore((s) => s.specimenText);
  const off = useNotForSystem("収録文字の表");
  const chars = cond.filter.fontChars;
  const shown = [...new Set([...chars].filter((c) => c.trim()))].join("");
  return (
    <Pill
      label="収録文字"
      value={shown}
      {...off}
      locked={locked}
      onLocked={onLocked}
      onClear={() => setFilter(CLEARED.fontChars.filter!)}
      width="w-72"
    >
      {() => (
        <div className="flex flex-col gap-2 p-2">
          <p className="text-dim">入力した文字をすべて収録しているフォントだけを残します。</p>
          <input
            autoFocus
            value={chars}
            placeholder="例：鬱 驚 ¥ é"
            aria-label="収録していてほしい文字"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setFilter({ fontChars: e.target.value })}
            className="h-8 w-full rounded-md border border-edge bg-bg px-2 text-sm outline-none focus:border-accent"
          />
          <div className="flex gap-1">
            <button
              disabled={!specimen.trim()}
              title={specimen.trim() ? undefined : "見本の文字が空です"}
              onClick={() =>
                setFilter({
                  fontChars: [...new Set([...specimen].filter((c) => c.trim()))].join(""),
                })
              }
              className="h-7 rounded-md px-2 ghost disabled:off"
            >
              見本の文字から入れる
            </button>
            <button
              disabled={!chars}
              onClick={() => setFilter({ fontChars: "" })}
              className="h-7 rounded-md px-2 ghost disabled:off"
            >
              消す
            </button>
          </div>
        </div>
      )}
    </Pill>
  );
}

export function FontConditions({ cond, locked, onLocked }: CondProps) {
  const setFilter = useStore((s) => s.setFilter);
  const view = useStore((s) => s.view);
  return (
    <>
      {CONDITIONS.map((c) => {
        const picked = cond.filter[c.key];
        // Opened as a place in the sidebar: the condition would only repeat it (docs/NAVIGATION.md).
        const inPlace =
          (c.key === "fontScripts" && view.kind === "fontScript") ||
          (c.key === "fontCategories" && view.kind === "fontCategory");
        const labels = picked.map((k) => c.values.find((v) => v.key === k)?.label ?? k);
        return (
          <Fragment key={c.key}>
            {c.key === "fontCategories" && <CharsCondition cond={cond} locked={locked} onLocked={onLocked} />}
            <Pill
              label={c.label}
              value={labels.join("・")}
              disabled={inPlace}
              title={inPlace ? `サイドバーで「${c.label}」の場所を開いているので、ここでは絞り込めません` : undefined}
              locked={locked}
              onLocked={onLocked}
              onClear={() => setFilter(CLEARED[c.key].filter!)}
              width="w-64"
            >
              {(open) => (
                <FontMenu
                  open={open}
                  condition={c}
                  picked={picked}
                  pick={(v) => setFilter({ [c.key]: v } as Partial<Filter>)}
                />
              )}
            </Pill>
          </Fragment>
        );
      })}
    </>
  );
}

function FontMenu({
  open,
  condition,
  picked,
  pick,
}: {
  open: boolean;
  condition: (typeof CONDITIONS)[number];
  picked: string[];
  pick: (v: string[]) => void;
}) {
  const facets = useFacets(condition.key, open);
  const counts: Record<string, number> | null = facets ? (facets[condition.key] as Facets[FontKey]) : null;
  return (
    <>
      {condition.values.map((v) => (
        <Option
          key={v.key}
          on={picked.includes(v.key)}
          count={counts ? (counts[v.key] ?? 0) : null}
          onClick={() => pick(toggled(picked, v.key))}
        >
          {v.label}
          {v.names && <span className="text-dim">{v.names}</span>}
        </Option>
      ))}
    </>
  );
}
