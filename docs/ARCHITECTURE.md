# 構成の方針：アプリの土台とフォントのコード

Typecase は Stockroom（hamirilo/stockroom）のフォントのモードを、別のアプリとして分けたもの。
アプリの土台（ライブラリ・DB・取り込み・フォルダ・タグ・一覧の骨組み・アップデート）は、のちに desktop-platform の共通の部品（core）へ切り出す予定なので、
**アプリの土台（core）** と **フォントのコード（features/fonts）** の境界を明確にしておく。

## 一覧と表示

- 項目はすべてフォント。対応する拡張子は `import::SUPPORTED_EXTS`（Rust）と `FONT_EXTS`（`lib/api.ts`）
- ライブラリの切り替えは頻度が低いのでサイドバーの一番下（`LibrarySwitcher`）
- 項目が入るフォルダは 1 つまで（`item_folders` の `item_id` が UNIQUE）。テーブルは多対多の形のままだが、
  フォルダは置き場所で、フォルダをまたぐまとまりはタグで表す。`move_to_folder` は前のフォルダから外し、`file_unfiled` は未分類のものだけを入れる
- タグは名前で 1 つ（`UNIQUE COLLATE NOCASE`）。`add_tags` は無ければ作る
- レイアウトは `LAYOUTS`（見本・グリッド）、グループ分けは `GROUPS`（`store.ts`）。`localStorage` の `layout` / `groupBy` に保存する。
  一覧は常に 1 ファミリー 1 行（`groupItems` の `families`、代表の行の `familyIds` が全スタイル）で、▸ で開いたファミリー（`openFamilies`）の
  太さ違いを行の下に出す（`familyMember`）。行が表す ID は `rowIds` で取る（選択・範囲選択・見出しのクリック）。docs/FONT_UI.md
- **シェルフ**（`components/Shelf.tsx`、`store.shelf`）：詳細パネル（`components/DetailsPanel.tsx`）のタブ。どちらのタブかは `store.panelTab`、
  ドラッグ中に出すのは `useShelfPeek`。中身は `tray` テーブルを `refresh` で一覧と一緒に取る。一覧として開く表示ではなく、`View` の `tray` はこの問い合わせにだけ使う。
  `FONT_SHELF_MAX`（8）件までで、比較ビュー（`features/fonts/CompareView.tsx`、`store.comparing`）を一覧の場所に出す。
  ファミリーの行をシェルフに置くと代表の 1 件になる（`shelfIds`）
- **場所と絞り込み**（docs/NAVIGATION.md）：サイドバーは場所（`View`）を 1 つ選ぶ。タグも場所（`View::Tag` / `{ kind: "tag", id }`）。
  絞り込みはツールバーの `components/FilterRow.tsx` 1 か所（言語・書体・太さ・特徴は `features/fonts/FontFilters.tsx` の
  `FontConditions` が同じ部品で出す）。一覧の問い合わせは `listQuery(s)`（`store.ts`）で作り、`listQuery(s, key)` はその条件だけを外したもの。
  メニューの件数は開いたときに `facet_counts`（`db.rs`。問い合わせの WHERE は `query_where` を `query_items` と共有）で数える。
  「5 / 13 件」の分母は `placeTotal`（サイドバーの件数から）
- ライブラリごとの設定（サイドバーで隠す項目・自分の見本のパターン）は `library.db` の `settings` テーブル（`lib/librarySettings.ts`）。docs/SETTINGS.md

## DB

`src-tauri/src/db.rs`。`SCHEMA_VERSION` は 1 で、`migrate` の手順は最初の 1 つだけ（テーブルをすべて作る）。
列を足すときは手順を 1 つ足し、`SCHEMA_VERSION` を上げる。どの手順も、もう一度走らせても壊れないように書く（古い版で開くと `user_version` が下がることがあるため）。
Stockroom のライブラリとは互換性がない。`images/` のあるフォルダ（Stockroom のライブラリ）は `Library::open` で断る。

## コマンド

アプリの操作は `src/lib/commands.ts` の `COMMANDS` に 1 つずつ定義する（id・名前・状態に応じた表示名・キー・
使えるか・チェック・実行）。次はすべてこの表から作るので、操作を足すときはまずここに足す（docs/MENUS.md）。

- 一覧のキー処理（`Grid.tsx` → `runKey`）。一覧の中だけの移動・評価の数字・Space / Enter は `Grid.tsx` に残す
  - ダイアログ・メニュー・パネルなど一覧の上に重なるものは、外枠に `data-modal` を付ける。それがある間、一覧のキー処理は何もしない（確認中の Delete で後ろの選択がゴミ箱に入らないように）
  - 入力欄のキー処理は `lib/ime.ts` の `composing` で日本語入力の変換中を除く（macOS では確定の Enter で `isComposing` がもう false のため）
- メニューバー（`lib/menuBar.ts`）。⌘ 付きのキーはアクセラレータ、1 文字のキーは表示だけ
- 右クリックメニューの行（`lib/menuItems.ts` の `commandItem` / `commandIcon`）
- ショートカット一覧（`lib/shortcuts.ts` の `shortcutSections`）。マウス操作やビューアだけのキーは説明の行として持つ

「一覧の中身への操作」（書き出し・シェルフにすべて追加・別のライブラリへ）は、対象を `ListSource`
（選択・表示中の一覧・フォルダ・スマートフォルダ・タグ・シェルフ）で受け、中身は `listTargets`（`lib/actions.ts`）で取る。

Rust のコマンドは `src/lib/api.ts`（フォントだけのものは `features/fonts/api.ts`）のラッパ経由で呼ぶ。ブラウザで UI だけを動かすモック
（`src/dev/mockBackend.ts`）も同じ PR で更新する。

## 境界

| 層 | 場所 | 中身 |
|---|---|---|
| アプリの土台（core） | `src/lib/*`, `src/store.ts`, `src/components/*` | ライブラリ・取り込み・フォルダ・タグ・スマートフォルダ・検索・一覧の骨組み（Grid / Sidebar / Toolbar / Inspector / Viewer）・設定・Updater |
| | `src-tauri/src/{db,import,library,search,proxy,transfer,export,commands}.rs` | スキーマ・クエリ、取り込み、ライブラリの中のファイル、検索式、OS のプロキシ、ライブラリ間のコピー・移動、書き出し、共通コマンド |
| フォント | `src/features/fonts/` | この端末のフォントの一覧・絞り込み・件数・シェルフへの差し込み・ライブラリとの照合（`system.ts`）、詳細パネル（`SystemFontPanel.tsx`）、照合の印（`FontLink.tsx`）、フォント専用コマンドのラッパ（`api.ts`）、フォントの読み込み（`loader.ts`）、見本の行とグリッドのタイル（`FontRows.tsx`）、ビューア（`FontView.tsx`）、詳細パネルの行（`FontDetails.tsx`）、絞り込みの行の言語・書体・太さ・特徴（`FontFilters.tsx`）、見本の文字の行と大きさ（`SpecimenControls.tsx`）、見本のパターン（`patterns.ts`）、比較ビュー（`CompareView.tsx`）、シェルフの行（`ShelfChip.tsx`）、ウェイト名（`weights.ts`） |
| | `src-tauri/src/fonts/` | パース・分類・見本の描画（`mod.rs`）、フォント専用コマンド（`commands.rs`）、この端末のフォントの読み込みとキャッシュ（`system.rs`） |

依存の向きは **features → core** のみ。core がフォントの知識を持つのは、DB に入っている語彙（`FONT_SCRIPTS` /
`FONT_CATEGORIES` のラベル、`Item` のフォント列、`Filter.fontScripts` など）までにとどめ、振る舞いは features に置く。
Rust の取り込み（`import.rs`）はサムネイルとメタデータのために `fonts::` を直接呼ぶ。core へ切り出すときは、ここを差し込みの形にする。

この端末のフォント（`View` の `{ kind: "system" }`、ID が `sys:` で始まる行）はライブラリの項目ではない（[SYSTEM_FONTS.md](SYSTEM_FONTS.md)）。
core が持つのはその語彙（`isSystemId` / `libraryIds`、`lib/api.ts`）まで。一覧と絞り込みの件数は `store.ts` の `refresh` と `FilterRow.tsx` の
`useFacets` で `features/fonts/system.ts` へ振り分ける。書き込みの操作は `commands.ts` の `mine` / `library` で無効にし、`actions.ts` の各操作の入口でも
`libraryIds` で外して、`sys:` の ID をライブラリのコマンドへ渡さない。例外はシェルフで、端末のフォントも置く
（`tray_system`。`actions.ts` の `addToTray` が振り分け、`refresh` で `fontShelf` が差し込む）。

共通の UI（`Grid.tsx` / `Sidebar.tsx` / `Shelf.tsx` / `App.tsx`）が features の部品を描く箇所（見本の行、シェルフの行、比較ビュー）では、
features 側が core の部品（`Row` / `Section`、`CellProps` / `showItemMenu`）を使うので import が循環する。
いずれも描画時にしか参照しないので問題ないが、core 側の部品を独立したファイルに出せばほどける。

## ライブラリの中のファイル

項目のファイルは `fonts/<id>/<元のファイル名>`。この場所は `library.rs` の関数だけで組み立て、
ほかで `"fonts"` を書かない（`FILES_DIR`）：`file_path`（`Item` から）、`stored_file`（id とファイル名だけを問い合わせたとき）、`item_dir`（項目のフォルダ）、
`store_file`（取り込みで書く）、`remove_item_dir`（失敗したときの後始末・削除）。アプリのフォルダ構成どおりの写しは書き出しで作る（docs/EXPORT.md）

## 外から来るファイルとセキュリティ

取り込むファイルはどこから来たか分からないものとして扱う。

- 大きさはファイルに書かれた値をそのまま信じず、上限を設けて読む（WOFF / WOFF2 の展開など）。
  リリースビルドは `panic = "abort"` なので、確保の失敗やパニックはアプリごと落ちる
- アプリは外からの接続を受け付けない（待ち受けるポートは無い）
- Web ビューの CSP は `tauri.conf.json` の `security.csp`。外のリソースを読み込む機能を足すときは、ここにも足す
  （開発時は `devCsp`）

## 今後

- アプリの土台を desktop-platform の共通の部品（core）に切り出す
