// Helpers for describing filters / smart folder rules in the UI.
import {
  fontCategoryLabel,
  fontFeatureLabel,
  fontScriptLabel,
  fontWeightLabel,
  formatBytes,
  type Filter,
  type Rule,
  type Tag,
} from "./api";

const DAY = 24 * 60 * 60 * 1000;

export function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Import date presets. `after` is computed when chosen. */
export const DATE_PRESETS: { label: string; after: () => number }[] = [
  { label: "今日", after: () => startOfToday() },
  { label: "7日以内", after: () => startOfToday() - 6 * DAY },
  { label: "30日以内", after: () => startOfToday() - 29 * DAY },
  { label: "今年", after: () => new Date(new Date().getFullYear(), 0, 1).getTime() },
];

const KB = 1024;
const MB = 1024 * 1024;
export const SIZE_PRESETS: { label: string; min: number | null; max: number | null }[] = [
  { label: "100KB 未満", min: null, max: 100 * KB - 1 },
  { label: "100KB〜1MB", min: 100 * KB, max: MB - 1 },
  { label: "1〜10MB", min: MB, max: 10 * MB - 1 },
  { label: "10MB 以上", min: 10 * MB, max: null },
];

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString("ja-JP");

function range(min: number | null, max: number | null, fmt: (n: number) => string): string {
  if (min != null && max != null) return `${fmt(min)}〜${fmt(max)}`;
  if (min != null) return `${fmt(min)} 以上`;
  if (max != null) return `${fmt(max)} 以下`;
  return "";
}

export function describeDate(f: Filter): string {
  if (f.importedAfter == null && f.importedBefore == null) return "";
  const preset = f.importedBefore == null && DATE_PRESETS.find((p) => p.after() === f.importedAfter);
  if (preset) return preset.label;
  // `before` is exclusive (start of the next day); show the inclusive last day.
  return range(f.importedAfter, f.importedBefore != null ? f.importedBefore - DAY : null, fmtDate);
}

export function describeSize(f: Filter): string {
  const preset = SIZE_PRESETS.find((p) => p.min === f.minSize && p.max === f.maxSize);
  if (preset) return preset.label;
  return range(f.minSize, f.maxSize, formatBytes);
}

/** One short phrase per condition, e.g. ["★3以上", "形式: otf", "タグ: 見出し"]. */
export function describeRule(rule: Rule, tags: Tag[]): string[] {
  const out: string[] = [];
  const f = rule.filter;
  if (rule.search.trim()) out.push(`「${rule.search.trim()}」`);
  if (rule.tagIds.length) {
    const names = rule.tagIds.map((id) => tags.find((t) => t.id === id)?.name).filter(Boolean);
    if (names.length) out.push(`タグ: ${names.join(rule.tagMatchAll ? " かつ " : " または ")}`);
  }
  if (rule.minRating) out.push(`★${rule.minRating}以上`);
  if (f.fontScripts?.length) out.push(`言語: ${f.fontScripts.map(fontScriptLabel).join("・")}`);
  if (f.fontCategories?.length) out.push(`書体: ${f.fontCategories.map(fontCategoryLabel).join("・")}`);
  if (f.fontWeights?.length) out.push(`太さ: ${f.fontWeights.map(fontWeightLabel).join("・")}`);
  if (f.fontFeatures?.length) out.push(`特徴: ${f.fontFeatures.map(fontFeatureLabel).join("・")}`);
  if (f.exts.length) out.push(`形式: ${f.exts.join(", ")}`);
  const date = describeDate(f);
  if (date) out.push(`追加日: ${date}`);
  const size = describeSize(f);
  if (size) out.push(`容量: ${size}`);
  return out;
}
