# Viewer

Windows 用の画像生成AIにて作成された画像向けビューワー

<!-- スクリーンショット (任意): docs/screenshots/ にファイルを置いて差し替え -->
<!-- ![スクリーンショット](docs/screenshots/main.png) -->

## 主な機能

- **生成 AI 画像のメタデータ表示** : NovelAI（ステルス / アルファ LSB）、ComfyUI（PNG / WebP / JPEG）、C2PA / Content Credentials、EXIF をポップアップ・詳細ペインで表示
- **タグフィルター** : タグで一覧を絞り込み
- **複数枚表示** : 1枚はもちろん、2枚だけでなく16枚まで同時表示可能

### 対応画像形式

JPEG / PNG / GIF / WebP / BMP / TIFF（TIFF は内部で PNG に変換して表示）

## 動作要件

- **Windows 11** : 追加モジュールなしで動作します。
- ソースからビルドする場合 : [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) が必要です。

配布バイナリは .NET 8 ランタイムを内包しており、初回起動時に展開処理が走るため少々起動に時間がかかります。
Windows 10 でも WebView2 ランタイムを入れれば理論上動作しますが、動作確認はとっていません。

## ビルド

単一 exe（ランタイム内包）として発行します。

```pwsh
dotnet publish Viewer/Viewer.csproj `
    -c Release -r win-x64 --self-contained true `
    -p:PublishSingleFile=true `
    -p:IncludeAllContentForSelfExtract=true `
    -p:EnableCompressionInSingleFile=true
```

出力: `Viewer/bin/Release/net8.0-windows/win-x64/publish/Viewer.exe`

## 実行 / データの保存場所

`Viewer.exe` を任意のフォルダに置いて実行すると、その横に以下が作られます（ポータブル構成）:

- `settings.toml` — アプリ設定（起動フォルダ / 表示設定 / 各種オプション）
- `shortcuts.json` — ショートカット（キー / マウス / ジェスチャ）の割り当て
- `WebView2Data/` — WebView2 ランタイムのユーザーデータ

別マシンへ移行する場合は、これらを exe ごとコピーすれば設定込みで動きます。

## ディレクトリ構成

```
viewer.sln                      ソリューション
Viewer/
├── App.xaml(.cs)               アプリのエントリポイント
├── MainWindow.xaml(.cs)        メインウィンドウ（ツリー + ファイル一覧 + 詳細ペイン）
├── ImageWindow.xaml(.cs)       画像ビューアウィンドウ
├── SettingsWindow.*            設定ウィンドウ
├── ShortcutsWindow.*           ショートカット設定ウィンドウ
├── Ipc/                        WebView2 ⇔ ホストの IPC ブリッジ（Tauri 互換シム）
├── Backend/                    列挙 / ファイル操作 / 書庫 / 画像変換 / メタデータ / 設定
├── Shell/                      Win32 シェル連携（ツリー / IFileOperation / コンテキストメニュー / アイコン）
├── WebAssets/                  WebView2 に配信する HTML / CSS / JS（一覧・ビューア・詳細・設定）
└── Resources/icon/app.ico      アプリアイコン
```

## 技術構成

- **WPF + .NET 8**（`net8.0-windows`）をホストに、UI の大部分を **WebView2**（HTML / CSS / JS）で描画
- WebView2 と C# ホスト間は postMessage 上に構築した **Tauri 互換 IPC シム**（`window.invoke` / イベント）で通信
- ファイル操作・ツリー・コンテキストメニューは Win32 シェル API（`IShellItem` / `IFileOperation` / `IContextMenu`）を直接利用してエクスプローラーと同等の挙動を実現
- 設定は [Tomlyn](https://github.com/xoofx/Tomlyn)（TOML）、書庫は [SharpCompress](https://github.com/adamhathcock/sharpcompress)、画像メタデータ（C2PA）は [PeterO.Cbor](https://github.com/peteroupc/CBOR) を使用

## 注意 / 免責事項

- 生成 AI 画像のメタデータ表示は、各フォーマット（NovelAI / ComfyUI / C2PA など）の仕様に依存します。フォーマット側の変更や情報が埋め込まれていない画像では表示できないことがあります。
- ご利用は自己責任でお願いします。

## ライセンス

本プロジェクトは [MIT License](LICENSE) です。
