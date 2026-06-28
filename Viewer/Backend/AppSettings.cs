using System.Collections.Generic;

namespace Viewer.Backend;

/// <summary>
/// 永続化する設定（仕様 §9。TOML, exe 隣 settings.toml）。
/// ポータブル設計。今はウィンドウ配置とペイン幅のみ。将来 アイコンサイズ/ソート/表示枚数等を追加。
/// </summary>
public sealed class AppSettings
{
    // ウィンドウ配置
    public double WindowWidth { get; set; } = 1200;
    public double WindowHeight { get; set; } = 700;
    public double? WindowLeft { get; set; }   // null = 既定（中央）
    public double? WindowTop { get; set; }
    public bool WindowMaximized { get; set; }

    // ペイン幅（左ツリー / 右詳細。中央一覧は可変）
    public double TreePaneWidth { get; set; } = 250;
    public double DetailsPaneWidth { get; set; } = 320;

    // 画像ウィンドウの配置（仕様 §4）
    public double ImageWindowWidth { get; set; } = 900;
    public double ImageWindowHeight { get; set; } = 700;
    public double? ImageWindowLeft { get; set; }
    public double? ImageWindowTop { get; set; }
    public bool ImageWindowMaximized { get; set; }
    public bool ImageWindowAlwaysOnTop { get; set; } = true; // 画像ウィンドウをメインウィンドウの前に常に表示する
    public bool ImageWindowPerTab { get; set; }              // タブごとに画像ウィンドウを開く（false=全タブ共有の1ウィンドウ）

    // 表示設定（メニューバーから変更・仕様 §1.1/§4.1）
    public double IconSize { get; set; } = 120;             // 一覧アイコンサイズ(px)
    public string SortMode { get; set; } = "name_asc";      // name_asc/name_desc/date_asc/date_desc
    public int ViewCount { get; set; } = 1;                 // 画像ウィンドウの同時表示枚数(1-16)
    public bool ReadingRtl { get; set; } = true;           // 右→左（漫画風）
    public string TrimMode { get; set; } = "short";         // レイアウト3のトリミング方式（none/both/vertical/horizontal/short/long）
    public double CropPenalty { get; set; } = 0.6;          // トリミング抑制度（列数決定で切り取り面積をどれだけ嫌うか）
    public bool FileNameWrap { get; set; }                  // ファイル名を折り返す（可変）。false=固定(1行省略)
    public string LayoutMode { get; set; } = "layout1";     // 画像ウィンドウのレイアウト方式（layout1/layout2…・仕様 §4.2）

    // 設定ウィンドウ（ツール → 設定）
    public bool ShowHidden { get; set; }                    // ファイル一覧：隠しファイル・フォルダーを表示する
    public bool EndMarker { get; set; } = true;             // 画像ウィンドウ：フォルダ末尾マーカーを表示する

    // 全体：起動時に開くフォルダ
    public string StartupMode { get; set; } = "last";       // "last"=前回 / "fixed"=決まったフォルダ / "none"=開かない
    public string StartupFolder { get; set; } = "";         // "fixed" のときのフォルダパス
    public string LastFolder { get; set; } = "";            // 前回終了時に開いていたフォルダ（"last" 用・互換）

    // 前回終了時のタブ群（"last" 起動時に全タブ復元）。各要素はフォルダパス（""=空タブ）。
    public List<string> OpenTabs { get; set; } = new();
    public int ActiveTabIndex { get; set; }                 // 復元時にアクティブにするタブの index

    // 画像ウィンドウ：新規に開いたときの表示枚数
    public string ImageCountMode { get; set; } = "last";    // "last"=前回開いていた枚数 / "fixed"=決まった枚数
    public int ImageCountFixed { get; set; } = 1;           // "fixed" のときの枚数(1-16)
    public bool LoopNavigation { get; set; } = true;        // 末尾の画像から最初の画像に移動する（循環）
    public int PreloadCount { get; set; } = 3;              // 画像前後の事前読み枚数(0-50)

    // ファイル一覧：サムネイル表示（重い場合に OFF にできる）
    public bool FolderThumbnails { get; set; } = true;      // フォルダのサムネイル（直下1枚目）
    public bool ArchiveThumbnails { get; set; } = true;     // 圧縮ファイルのサムネイル（中の1枚目）
    public bool SyncListSelection { get; set; } = true;     // 表示している画像をファイル一覧上で選択する
    public bool SyncTreeSelection { get; set; } = true;     // 開いているフォルダをツリーで選択する
    public bool ShowArchivesInTree { get; set; } = true;    // フォルダツリー：圧縮ファイルを表示する
}
