# アプリのアイコン

`icon.svg` が元。紙の色の地に、セリフ体の「Aa」と赤い下線。文字は Caladea（SIL Open Font License）で、各サイズの PNG・icns・ico はこの SVG を 1024px の PNG にしてから作る。

```bash
bunx tauri icon <1024px の PNG>
```

`tauri icon` は Android・iOS 用や 64x64 も作るが、使っていないので消す（`src-tauri/icons/` には今あるファイルだけを置く）。設定画面の版の表示も `src-tauri/icons/128x128@2x.png` を使う。
