# Typecase

集めたフォントをしまっておき、見比べて選ぶためのローカルのアプリ（Tauri 2 / Mac・Windows）。
フォントのファイルを 1 つのライブラリにしまい、フォルダ・タグ・評価・検索で整理して、同じ文字で見比べて選ぶ。

[Stockroom](https://github.com/hamirilo/stockroom) から分かれた（Stockroom のフォントのモードを、別のアプリにしたもの）。経緯は Stockroom の [docs/FONT_APP.md](https://github.com/hamirilo/stockroom/blob/main/docs/FONT_APP.md)。

## 主な機能

- **取り込み**：TTF・OTF・WOFF・WOFF2・TTC・OTC をドラッグ&ドロップ・貼り付けで。同じファイルは重複として除く
- **一覧**：見本（1 行ずつ同じ文字で）とグリッド。ファミリーを 1 行にまとめ、▸ で太さ違いを開く
- **整理**：入れ子フォルダ・タグ・★評価・お気に入り・ピン留め・メモ・色分け、スマートフォルダ、書体（明朝・ゴシック…）の手直し
- **検索・絞り込み**：名前・ファミリー名・メモ・タグで検索（除外・OR・語句）、言語・書体・太さ・特徴・形式・追加日・容量で絞り込み
- **シェルフと比較**：比べたいフォントを最大 8 件シェルフに置き、並べて比較する
- **この端末のフォント**：インストールされているフォントを、ライブラリに取り込まずに読み取り専用で並べる。シェルフに置いてライブラリのフォントと比べられる
- **書き出し・別のライブラリへ**：元のファイルのまま書き出す、ライブラリ全体をフォルダ構成どおりに書き出す、別のライブラリへコピー・移動

詳しい使い方・キー操作・ライブラリの構造とバックアップは [docs/FEATURES.md](docs/FEATURES.md)。

## インストール

[Releases](https://github.com/hamirilo/typecase/releases) から入手する。署名なしのビルドなので、**初回インストール時だけ**警告が出る。

- **macOS（Apple Silicon 専用）**：`.dmg` を開いて「アプリケーション」へコピー → 起動して「開発元を検証できない」と出たら「完了」→ **システム設定 › プライバシーとセキュリティ** の「このまま開く」。
  ターミナルで `xattr -dr com.apple.quarantine "/Applications/Typecase.app"` を実行しても良い
- **Windows**：`-setup.exe` を実行 → SmartScreen が出たら「詳細情報」→「実行」

2 回目以降はアプリ内で更新する（起動時に確認。手動では設定（⌘,）→「一般」の「アップデート」→「アップデートを確認」）。何が変わったかは [Releases](https://github.com/hamirilo/typecase/releases) の各版のページにある。

### Stockroom のフォントから移るとき

Stockroom のライブラリはそのまま開けない（互換性はない）。Stockroom でフォントを書き出し（ファイル › ライブラリ全体を書き出し…）、書き出したフォルダを Typecase にドロップして取り込み直す。フォルダ分けはフォルダ構成として戻るが、タグ・評価・メモは引き継がれない。

## 開発

前提：Bun、Node.js 22+、Rust（stable）、[Tauri の前提環境](https://tauri.app/start/prerequisites/)

```bash
bun install
bun run tauri dev      # アプリを起動
bun run test           # Rust のユニットテスト + 型チェック
```

ブラウザ用のモック・構成・リリースの手順は [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## ドキュメント

| | |
|---|---|
| [FEATURES.md](docs/FEATURES.md) | 機能と使い方、キー操作、ライブラリの構造、バックアップ |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | 開発環境、ソースの構成、リリース |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 構成の方針（アプリの土台とフォントのコードの境界） |
| [SETTINGS.md](docs/SETTINGS.md) | 設定画面とライブラリごとの設定 |
| [MENUS.md](docs/MENUS.md) | メニューの構成 |
| [UI.md](docs/UI.md) | 画面の原則（表示を切り替えても操作の位置を不必要に変えない） |
| [NOTIFICATIONS.md](docs/NOTIFICATIONS.md) | 知らせ方（その場・HUD・トースト・OS の通知・ダイアログの使い分け、トーストの秒数） |
| [NAVIGATION.md](docs/NAVIGATION.md) | サイドバーとツールバーの役割（場所・絞り込み・表示） |
| [FONT_UI.md](docs/FONT_UI.md) | フォントの画面（見本・グループ分け・シェルフ・比較） |
| [GROUP_TOC.md](docs/GROUP_TOC.md) | グループ分けの目次（いま見ている区切りの表示と、区切りへのジャンプ） |
| [SYSTEM_FONTS.md](docs/SYSTEM_FONTS.md) | この端末のフォント（ライブラリに取り込まない読み取り専用の一覧） |
| [EXPORT.md](docs/EXPORT.md) | ライブラリ全体の書き出し（すべてのファイルをフォルダ構成どおりに） |
| [ROADMAP.md](docs/ROADMAP.md) | 今後の予定 |
