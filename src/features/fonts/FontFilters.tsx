// The fonts' conditions in the filter row (docs/NAVIGATION.md): writing
// system, typeface style, weight and features. Within one the values picked
// are "any of"; with the other conditions, "all of". The counts are with the
// other conditions on (`useFacets`).
// FilterRow supplies the button and menu chrome and renders these: the import
// cycle is fine because everything is used at render time, not at load.
import { Option, Pill, toggled, useFacets, type CondProps } from "../../components/FilterRow";
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
          <Pill
            key={c.key}
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
        <Option key={v.key} on={picked.includes(v.key)} count={counts ? (counts[v.key] ?? 0) : null} onClick={() => pick(toggled(picked, v.key))}>
          {v.label}
          {v.names && <span className="text-dim">{v.names}</span>}
        </Option>
      ))}
    </>
  );
}
