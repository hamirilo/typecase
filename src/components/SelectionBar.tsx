import { Download, FolderInput, MoreHorizontal, RotateCcw, Tag, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { deleteSelection, exportSelection } from "../lib/actions";
import { api, isSystemId } from "../lib/api";
import { command, isEnabled } from "../lib/commands";
import { comboText } from "../lib/shortcuts";
import { useStore } from "../store";
import { showItemMenu } from "./Grid";
import { TagInput } from "./Inspector";

/**
 * まとめて行う操作のバー。一覧の下に浮かぶ（docs/MENUS.md §7）。
 * 詳細パネル（情報タブ）には操作を置かず、選んだものに「何かをする」のはここに集める。
 *
 * - 2 件以上を選んでいるときに出す。ゴミ箱の中だけは 1 件でも出し、中身を［復元］［完全に削除］にする
 * - 面は「有効」の色（tonal）。ダークは青みの面、ライトは淡い青
 * - 左から：件数、印（お気に入り・ピン留め）とシェルフ、移動・タグ・書き出し・「その他」（右クリックと同じ）、
 *   区切りの右にゴミ箱。ゴミ箱は赤い文字と名前付きで離し、押し間違えないようにする
 * - 名前はバーの幅で段階的に外す（印 → 移動など → ゴミ箱）。ボタンの並びと場所は変えない
 */
export function SelectionBar() {
  const count = useStore((s) => s.selected.size);
  const isTrash = useStore((s) => s.view.kind === "trash");
  const state = useStore();
  if (count < (isTrash ? 1 : 2)) return null;
  const ids = [...state.selected];

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4 @container">
      <div
        role="toolbar"
        aria-label="選択したフォントの操作"
        className="pointer-events-auto flex max-w-full animate-fade-in items-center gap-0.5 rounded-[14px] border border-tonal-edge/50 bg-tonal px-2 py-1.5 text-[13px] text-on-tonal shadow-xl shadow-black/40"
      >
        <span className="flex shrink-0 items-center gap-2 pr-1.5 pl-2.5 text-sm font-bold tabular-nums">
          {count} 件を選択中
          <button
            title="選択を解除（Esc）"
            aria-label="選択を解除（Esc）"
            onClick={() => state.setSelection([])}
            className="flex h-6 w-6 items-center justify-center rounded-full bg-ink/10 hover:bg-ink/20"
          >
            <X size={13} />
          </button>
        </span>
        <Sep />
        {isTrash ? <TrashActions ids={ids} /> : <Actions ids={ids} />}
      </div>
    </div>
  );
}

/** ふだんの一覧。 */
function Actions({ ids }: { ids: string[] }) {
  const state = useStore();
  // Installed fonts are only looked at (docs/SYSTEM_FONTS.md).
  const system = ids.some(isSystemId);
  const readOnly = system ? "（この端末のフォントは読み取り専用です）" : "";

  // 印とシェルフ。名前は固定（押すたびに変わる言い方はツールチップへ）で、隣を押し出さない。
  const flag = (id: string) => {
    const c = command(id);
    const Icon = c.icon;
    const key = c.keys?.[0];
    const on = c.checked?.(state);
    return (
      <Btn
        key={id}
        title={`${c.label ? c.label(state) : c.title}${key ? `（${comboText(key)}）` : ""}`}
        onClick={() => c.run(useStore.getState())}
        disabled={!isEnabled(c, state)}
        active={on}
        label={c.title}
        hide="flag"
      >
        {Icon && <Icon size={15} fill={on && id !== "item.tray" ? "currentColor" : "none"} />}
      </Btn>
    );
  };
  const more = (e: React.MouseEvent) => {
    const index = state.items.findIndex((i) => i.id === ids[0] || i.familyIds?.includes(ids[0]));
    if (index < 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    showItemMenu({ clientX: r.left, clientY: r.top - 4 }, state.items[index], index);
  };

  return (
    <>
      {flag("item.favorite")}
      {flag("item.pin")}
      {flag("item.tray")}
      <Sep />
      <Btn
        title={`フォルダへ移動…（${comboText("Mod+Shift+J")}）${readOnly}`}
        onClick={() => state.setPicker("move")}
        label="移動…"
        hide="op"
        disabled={system}
      >
        <FolderInput size={15} />
      </Btn>
      <TagButton ids={ids} disabled={system} readOnly={readOnly} />
      <Btn
        title={`書き出し…（${comboText("Mod+E")}）${readOnly}`}
        onClick={() => exportSelection(ids)}
        label="書き出し…"
        hide="op"
        disabled={system}
      >
        <Download size={15} />
      </Btn>
      <Btn title="そのほかの操作（右クリックと同じ）" onClick={more} label="その他" hide="op">
        <MoreHorizontal size={15} />
      </Btn>
      <DangerSep />
      <Btn
        title={`ゴミ箱へ移動（${comboText("Mod+Backspace")}）${readOnly}`}
        onClick={() => deleteSelection(ids)}
        label="ゴミ箱へ"
        hide="last"
        danger
        disabled={system}
      >
        <Trash2 size={15} />
      </Btn>
    </>
  );
}

/**
 * 「タグ…」：選んだものにまとめてタグを付ける。バーの上に入力欄を出す。
 * Enter で付けて、続けて入力できる。Esc か外のクリックで閉じる。
 */
function TagButton({ ids, disabled, readOnly }: { ids: string[]; disabled: boolean; readOnly: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [open]);
  return (
    <div ref={box} className="relative flex">
      <Btn
        title={`タグを付ける${readOnly}`}
        onClick={() => setOpen((o) => !o)}
        active={open}
        label="タグ…"
        hide="op"
        disabled={disabled}
      >
        <Tag size={15} />
      </Btn>
      {open && (
        <div
          data-modal
          className="absolute bottom-full left-1/2 mb-3 w-64 -translate-x-1/2 rounded-lg border border-line bg-raised p-2 text-fg shadow-xl"
        >
          <div className="mb-1.5 px-0.5 text-[11px] text-dim">{ids.length} 件にタグを付ける</div>
          <TagInput
            up
            autoFocus
            exclude={new Set()}
            onDone={() => setOpen(false)}
            onAdd={(names) => {
              const s = useStore.getState();
              s.rememberTags(names);
              s.run(() => api.addTags(ids, names));
            }}
          />
        </div>
      )}
    </div>
  );
}

/** ゴミ箱の中：復元と完全に削除（詳細パネルから移した）。 */
function TrashActions({ ids }: { ids: string[] }) {
  const run = useStore((s) => s.run);
  return (
    <>
      <Btn title="元の場所に戻す" onClick={() => run(() => api.restoreItems(ids))} label="復元">
        <RotateCcw size={15} />
      </Btn>
      <DangerSep />
      <Btn title="完全に削除（元に戻せません）" onClick={() => deleteSelection(ids)} label="完全に削除" danger>
        <Trash2 size={15} />
      </Btn>
    </>
  );
}

const Sep = () => <div className="mx-1.5 h-5 w-px shrink-0 bg-on-tonal/25" />;
const DangerSep = () => <div className="mx-2 h-5 w-px shrink-0 bg-danger/50" />;

/** 名前を外す幅（バーの外側のコンテナの内側の幅。全部の名前を出すとバーは約 780px）。よく使う操作ほど後に外す。 */
const HIDE = {
  flag: "@max-[54rem]:hidden",
  op: "@max-[40rem]:hidden",
  last: "@max-[30rem]:hidden",
} as const;

function Btn({
  title,
  onClick,
  label,
  hide,
  active,
  danger,
  disabled,
  children,
}: {
  title: string;
  onClick: (e: React.MouseEvent) => void;
  label?: string;
  hide?: keyof typeof HIDE;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-[34px] shrink-0 items-center gap-1.5 rounded-md px-1.5 whitespace-nowrap disabled:off ${
        danger
          ? "bg-danger/12 text-danger enabled:hover:bg-danger/20"
          : active
            ? "bg-ink/10 font-semibold enabled:hover:bg-ink/15"
            : "enabled:hover:bg-ink/12"
      }`}
    >
      {children}
      {label && <span className={hide ? HIDE[hide] : undefined}>{label}</span>}
    </button>
  );
}
