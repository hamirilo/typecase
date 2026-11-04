# 開発

前提：[Bun](https://bun.sh/)、Node.js 22+（Vite と Tauri の CLI は Node.js で動く）、Rust（stable）、[Tauri の前提環境](https://tauri.app/start/prerequisites/)

```bash
bun install
bun run tauri dev      # アプリを起動
bun run test           # Rust のユニットテスト + 型チェック（`bun test` は Bun のテストランナーなので使わない）
bun run tauri build    # 配布用ビルド（.dmg / -setup.exe。署名鍵が要る、下の「リリース」）
```

- `bun run dev` でブラウザから開くと、Rust 側の代わりにインメモリのモック（`src/dev/mockBackend.ts`）で動く。UI だけ触りたいとき用（インポートは不可）。
  ブラウザではフォントの中身を読めないので、見本は「見本を表示できません」になる（一覧・絞り込み・設定などの画面を確かめる用）。
- アプリの土台とフォントのコードの境界は [ARCHITECTURE.md](ARCHITECTURE.md) にまとめてある。
- テスト用ライブラリの生成：`bun run seed /path/to/Test.library /System/Library/Fonts`（フォルダの中のフォントをすべて取り込む。Windows は `C:\Windows\Fonts`）
- フォントの取り込みのテストは、その OS に入っているフォントを使う（macOS・Windows の標準のフォント、Linux は DejaVu。`src-tauri/src/fonts/mod.rs` の `tests::SINGLE`）。
  Linux の CI では `fonts-dejavu-core` を入れている

## 構成

```
src/                    React UI
  App.tsx               レイアウト、ファイルのドロップ・貼り付け
  store.ts              zustand ストア（表示条件・選択・再読込）
  lib/api.ts            Rust コマンドの型付きラッパ（共通）
  lib/actions.ts        ダイアログを伴う操作（インポート・削除など）
  lib/layouts.ts        見本・グリッドのレイアウト計算（位置を求めて仮想スクロール）
  lib/rule.ts           絞り込み条件の表示用ヘルパ
  components/           Sidebar / Toolbar / Grid / Inspector / Viewer ほか（共通の UI）
  features/fonts/       フォント専用の UI と API（見本行・ビューア・詳細・絞り込み・比較・この端末のフォント・フォントの読み込み）
  dev/mockBackend.ts    ブラウザ開発用モック
src-tauri/src/
  db.rs                 スキーマ・クエリ（＋テスト）
  import.rs             コピー・ハッシュ・サムネイル生成（rayon で並列）
  fonts/mod.rs          フォント：WOFF / WOFF2 の展開、TTC から 1 書体を取り出す、名前・文字一覧、見本の描画
  fonts/commands.rs     フォント専用のコマンド
  fonts/system.rs       この端末のフォントの読み込みとキャッシュ
  search.rs             検索構文のパーサ
  library.rs            ライブラリの作成・オープン・項目のファイルの場所・ファイル削除
  export.rs             書き出し：一覧の書き出し、ライブラリ全体をフォルダ構成どおりに（docs/EXPORT.md）
  transfer.rs           別のライブラリへのコピー・移動
  proxy.rs              OS のプロキシ設定（アップデートの確認・ダウンロード用）
  commands.rs           フロントから呼ぶコマンド（共通）
src-tauri/examples/seed.rs  テストデータ生成（フォルダのフォントを取り込む）
```

アプリ内のドラッグ&ドロップは HTML5 DnD ではなく pointer イベントで実装している（Windows では Tauri のファイルドロップ受付と HTML5 DnD が両立しないため）。

## リリース

`v*` タグを push すると GitHub Actions で macOS（Apple Silicon 専用）と Windows のインストーラがビルドされ、そのタグのリリースが下書きで作られてインストーラが添付される（内容を確認して Publish）。手動実行（workflow_dispatch）の場合は Actions の Artifacts にだけ出る。

手順：

1. `package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` のバージョンを上げる → `chore: vX.Y.Z` でコミット → `git tag vX.Y.Z && git push --tags`
2. ビルドが終わったら、下書きリリースの本文に**変更点を書く**（下の「リリースノート」）。ワークフローが入れる本文はインストーラの 1 行だけなので、書かないと何が変わったか分からない
3. 下書きリリースを **Publish**

アプリ内アップデートは `hamirilo/typecase` の `releases/latest/download/latest.json` を見るので、**Publish するまで配信されない**（下書きのうちは旧バージョンのまま）。リリースには次が添付される。

- `Typecase_X.Y.Z_aarch64.dmg` / `-setup.exe`：初回インストール用
- `Typecase.app.tar.gz` と `.sig`、`-setup.exe` の `.sig`、`latest.json`：アプリ内アップデート用（tauri-action が生成）

更新ファイルの署名鍵は GitHub Actions の Secrets に置く（`TAURI_SIGNING_PRIVATE_KEY`：秘密鍵ファイルの中身、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：パスワード）。対応する公開鍵は `tauri.conf.json` の `plugins.updater.pubkey`。鍵は Typecase 専用で、Stockroom の鍵とは別のもの（Stockroom の更新が Typecase に入ることはない。逆も同じ）。**秘密鍵を失うと配布済みのアプリに更新を届けられなくなる**ので、必ずバックアップを取る。

ローカルで配布用ビルドをするときも署名鍵が要る（`createUpdaterArtifacts` が有効なため）。

```bash
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/typecase.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD='…' bun run tauri build
```

#### 今の鍵は一時的なもの

今の鍵（公開鍵の ID `9ED0C9CBF04C7649`）は、本番の配布の前に替える前提の一時的なもの。替えるときは次のどちらか。

- **まだ自分しか使っていないうち**：新しい鍵を作り（`bunx tauri signer generate -w ~/.tauri/typecase.key`）、`pubkey` と Secrets を差し替え、新しい版を手で入れ直す。古い鍵は捨ててよい
- **配った人がいるとき**：入っているアプリは自分の中の公開鍵で更新を確かめるので、2 回に分ける。① 新しい公開鍵を入れた版を、**今の鍵で**署名して出す ② その次の版から新しい鍵で署名する。①を飛ばすか今の秘密鍵をなくすと、配った人は自動で更新できず、入れ直しになる。切り替えが終わるまで今の秘密鍵は消さない

### リリースノート

アプリの「アップデート」の欄は GitHub のリリースページを開くので、利用者が変更点を知る場所はリリースの本文になる。

前回のタグからマージされた PR を元に書く。

```bash
git log --merges --oneline vPREV..vX.Y.Z   # マージされた PR（#番号とブランチ名）
gh pr view <番号>                          # 中身を確かめる
```

- 利用者から見えることだけを、日本語のですます調で書く。PR のタイトルやコミットメッセージは開発者向けの文言なので、そのまま貼らない。内部の整理・テスト・ビルドの変更は書かない
- 画面の場所ごとに `###` の見出しで分ける（例：Quick Look（ビューア）／一覧／サイドバー／設定）
- 何がどう変わったかと、必要なら前はどうだったか・どう操作するかを書く
- 最後に「インストール」の節を残す

書いたら `--notes-file` で本文を置き換える（見本は v0.28.1：`gh release view v0.28.1`）。

```bash
gh release edit vX.Y.Z --notes-file notes.md
```

```markdown
## 変更点

### Quick Look（ビューア）
- 〜できるようにしました。これまでは〜でした

### 一覧
- 〜

## インストール

インストーラ：macOS（Apple Silicon）は .dmg、Windows は -setup.exe
```

## アプリ内アップデートの仕組み

会社のネットワークなどでプロキシが必要な場合は、OS のプロキシ設定（自動プロキシ設定の PAC を含む）をそのまま使う（`src-tauri/src/proxy.rs`）。

アプリ自身が書き出したファイルには macOS の quarantine 属性が付かないので、この経路で更新すると Gatekeeper / SmartScreen の警告は出ない。更新ファイルは Tauri Updater の鍵（minisign）で署名されていて、アプリ側の公開鍵と一致しないものは適用されない。
