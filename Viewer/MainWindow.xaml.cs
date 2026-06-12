using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Viewer.Backend;
using Viewer.Ipc;
using Viewer.Shell;

namespace Viewer;

public partial class MainWindow : Window
{
    private const string AppHost = "https://app.viewer";
    private const string FileHost = "file.viewer"; // 画像配信用の仮想ホスト
    private const string Dummy = "__dummy__";

    private IpcBridge? _listBridge;
    private IpcBridge? _detailsBridge;
    private string _webAssetsPath = "";
    private CoreWebView2Environment? _env;

    // イメージウィンドウ（仕様 §4 / D.7：当面1個のみ）。
    private ImageWindow? _imageWindow;
    private IpcBridge? _imageBridge;
    private object? _pendingViewerPayload;

    // ショートカット編集ウィンドウ（仕様 §8：単一インスタンス）。
    private ShortcutsWindow? _shortcutsWindow;
    private SettingsWindow? _settingsWindow;

    // 表示中フォルダーの監視（仕様 §1.5）。一覧ペインが watch_folder で対象を通知する。
    private FileSystemWatcher? _watcher;
    private string _lastFolder = ""; // 最後に表示した実フォルダー（「前回開いていたフォルダ」用）
    private bool _suppressTreeNavigate; // ツリー選択をプログラムから行う間、navigate 再発火を抑止
    private DispatcherTimer? _fsDebounce;
    private string _watchedFolder = "";

    private AppSettings _settings = new();

    public MainWindow()
    {
        InitializeComponent();
        _settings = SettingsService.Load();
        ApplySettings(_settings);
        Loaded += OnLoaded;
        Closing += OnClosing;
    }

    // ---- 設定の適用・保存（仕様 §9） ----
    private void ApplySettings(AppSettings s)
    {
        Width = s.WindowWidth;
        Height = s.WindowHeight;
        if (s.WindowLeft is double l && s.WindowTop is double t)
        {
            Left = l;
            Top = t;
        }
        else
        {
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
        }
        TreeCol.Width = new GridLength(s.TreePaneWidth);
        DetailsCol.Width = new GridLength(s.DetailsPaneWidth);
        if (s.WindowMaximized) WindowState = WindowState.Maximized;
        Backend.ListingService.ShowHidden = s.ShowHidden; // 隠しファイル表示（一覧/ツリー）
    }

    private void OnClosing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        // 表示設定（_settings の表示系）は維持しつつ、ウィンドウ配置を更新して保存。
        if (WindowState == WindowState.Maximized)
        {
            var rb = RestoreBounds; // 次回も最大化で開くが、復元サイズは保持
            _settings.WindowWidth = rb.Width; _settings.WindowHeight = rb.Height;
            _settings.WindowLeft = rb.Left; _settings.WindowTop = rb.Top;
            _settings.WindowMaximized = true;
        }
        else
        {
            _settings.WindowWidth = Width; _settings.WindowHeight = Height;
            _settings.WindowLeft = Left; _settings.WindowTop = Top;
            _settings.WindowMaximized = false;
        }
        _settings.TreePaneWidth = TreeCol.ActualWidth > 0 ? TreeCol.ActualWidth : TreeCol.Width.Value;
        _settings.DetailsPaneWidth = DetailsCol.ActualWidth > 0 ? DetailsCol.ActualWidth : DetailsCol.Width.Value;
        if (!string.IsNullOrEmpty(_lastFolder)) _settings.LastFolder = _lastFolder; // 起動時復元用
        SettingsService.Save(_settings);
    }

    // ---- メニュー（ファイル/ツール/ヘルプ）----
    // 表示系（ソート/アイコンサイズ＝一覧アドレスバー、表示枚数/レイアウト/読み方向/トリミング
    // ＝画像ウィンドウ左上）はメニュー外。ファイル名は常に折り返し固定。
    private void Exit_Click(object sender, RoutedEventArgs e) => Close();

    private void OpenShortcuts_Click(object sender, RoutedEventArgs e) => OpenShortcutsWindow();

    private void OpenSettings_Click(object sender, RoutedEventArgs e) => OpenSettingsWindow();

    private async void OpenSettingsWindow()
    {
        if (_settingsWindow != null) { _settingsWindow.Activate(); return; }

        var win = new SettingsWindow { Owner = this };
        _settingsWindow = win;
        win.Closed += (_, _) => { if (ReferenceEquals(_settingsWindow, win)) _settingsWindow = null; };
        win.Show();

        await SetupWebViewAsync(win.View, "settings.html", b => RegisterCommands(b, isList: false));
        win.View.CoreWebView2.WindowCloseRequested += (_, _) => win.Close();
    }

    private void About_Click(object sender, RoutedEventArgs e)
    {
        var asm = System.Reflection.Assembly.GetExecutingAssembly();
        var ver = asm.GetName().Version?.ToString() ?? "1.0.0.0";
        MessageBox.Show(this,
            $"画像ビューワー\nバージョン {ver}",
            "バージョン情報", MessageBoxButton.OK, MessageBoxImage.Information);
    }

    private async void OpenShortcutsWindow()
    {
        if (_shortcutsWindow != null) { _shortcutsWindow.Activate(); return; }

        var win = new ShortcutsWindow { Owner = this };
        _shortcutsWindow = win;
        win.Closed += (_, _) => { if (ReferenceEquals(_shortcutsWindow, win)) _shortcutsWindow = null; };
        win.Show();

        await SetupWebViewAsync(win.View, "shortcuts.html", b => RegisterCommands(b, isList: false));
        // shortcuts.html は window.close() で閉じる → WindowCloseRequested を受けて WPF 側を閉じる。
        win.View.CoreWebView2.WindowCloseRequested += (_, _) => win.Close();
    }

    private object ViewSettingsPayload() => new
    {
        icon_size = _settings.IconSize,
        sort_mode = _settings.SortMode,
        view_count = _settings.ViewCount,
        reading_rtl = _settings.ReadingRtl,
        trim = _settings.Trim,
        file_name_wrap = _settings.FileNameWrap,
        layout = _settings.LayoutMode,
        end_marker = _settings.EndMarker,
        loop = _settings.LoopNavigation,
        preload = _settings.PreloadCount,
        folder_thumbnails = _settings.FolderThumbnails,
        archive_thumbnails = _settings.ArchiveThumbnails,
    };

    // 設定ウィンドウ用ペイロード（カテゴリ：全体 / ファイル一覧 / 画像ウィンドウ）。
    private object SettingsPayload() => new
    {
        show_hidden = _settings.ShowHidden,
        end_marker = _settings.EndMarker,
        startup_mode = _settings.StartupMode,
        startup_folder = _settings.StartupFolder,
        image_count_mode = _settings.ImageCountMode,
        image_count_fixed = _settings.ImageCountFixed,
        loop_navigation = _settings.LoopNavigation,
        preload_count = _settings.PreloadCount,
        folder_thumbnails = _settings.FolderThumbnails,
        archive_thumbnails = _settings.ArchiveThumbnails,
        sync_list_selection = _settings.SyncListSelection,
        sync_tree_selection = _settings.SyncTreeSelection,
    };

    // 設定ウィンドウからの変更を反映・保存。value は bool/string 混在のため JsonElement で受ける。
    private void ApplySetting(System.Text.Json.JsonElement args)
    {
        switch (Str(args, "key"))
        {
            case "show_hidden":
                _settings.ShowHidden = Bool(args, "value");
                Backend.ListingService.ShowHidden = _settings.ShowHidden;
                SettingsService.Save(_settings);
                // 一覧を再読込して隠し項目の増減を反映（選択は reconcile が維持）。
                // ツリーは次回展開時（または再起動後）に反映される。
                _listBridge?.EmitEvent("reload_list", null);
                break;
            case "end_marker":
                _settings.EndMarker = Bool(args, "value");
                SettingsService.Save(_settings);
                _imageBridge?.EmitEvent("view_settings_changed", ViewSettingsPayload());
                break;
            case "startup_mode":
                _settings.StartupMode = Str(args, "value");
                SettingsService.Save(_settings);
                break;
            case "startup_folder":
                _settings.StartupFolder = Str(args, "value");
                SettingsService.Save(_settings);
                break;
            case "image_count_mode":
                _settings.ImageCountMode = Str(args, "value");
                SettingsService.Save(_settings);
                break;
            case "image_count_fixed":
                if (args.TryGetProperty("value", out var iv) && iv.TryGetInt32(out var n))
                {
                    _settings.ImageCountFixed = Math.Clamp(n, 1, 16);
                    SettingsService.Save(_settings);
                }
                break;
            case "loop_navigation":
                _settings.LoopNavigation = Bool(args, "value");
                SettingsService.Save(_settings);
                _imageBridge?.EmitEvent("view_settings_changed", ViewSettingsPayload());
                break;
            case "preload_count":
                if (args.TryGetProperty("value", out var pv) && pv.TryGetInt32(out var pc))
                {
                    _settings.PreloadCount = Math.Clamp(pc, 0, 50);
                    SettingsService.Save(_settings);
                    _imageBridge?.EmitEvent("view_settings_changed", ViewSettingsPayload());
                }
                break;
            case "folder_thumbnails":
                _settings.FolderThumbnails = Bool(args, "value");
                SettingsService.Save(_settings);
                _listBridge?.EmitEvent("view_settings_changed", ViewSettingsPayload()); // フラグ更新
                _listBridge?.EmitEvent("reload_list_full", null);                       // 全再読込で反映
                break;
            case "archive_thumbnails":
                _settings.ArchiveThumbnails = Bool(args, "value");
                SettingsService.Save(_settings);
                _listBridge?.EmitEvent("view_settings_changed", ViewSettingsPayload());
                _listBridge?.EmitEvent("reload_list_full", null);
                break;
            case "sync_list_selection":
                _settings.SyncListSelection = Bool(args, "value");
                SettingsService.Save(_settings);
                break;
            case "sync_tree_selection":
                _settings.SyncTreeSelection = Bool(args, "value");
                SettingsService.Save(_settings);
                if (_settings.SyncTreeSelection && !string.IsNullOrEmpty(_lastFolder)) _ = SelectInTree(_lastFolder);
                break;
        }
    }

    // 起動時に開くフォルダを解決（設定モードに従う）。開かない/未存在なら null。
    private string? ResolveStartupFolder()
    {
        var path = _settings.StartupMode switch
        {
            "last" => _settings.LastFolder,
            "fixed" => _settings.StartupFolder,
            _ => "", // "none"
        };
        return (!string.IsNullOrEmpty(path) && Directory.Exists(path)) ? path : null;
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        ApplyTitleBarTheme(); // タイトルバー（フレーム）をクリーム配色に（Windows 11）

        // WebAssets は同梱コンテンツ（単一 exe では一時展開先）なので BaseDirectory 基準。
        _webAssetsPath = Path.Combine(AppContext.BaseDirectory, "WebAssets");

        // 設定類は実 exe フォルダーに置く（単一 exe でも消えないように・仕様 §9）。
        var userData = Backend.AppPaths.Combine("WebView2Data");
        _env = await CoreWebView2Environment.CreateAsync(null, userData);

        _listBridge = await SetupWebViewAsync(ListView, "list.html", b => RegisterCommands(b, isList: true));
        _detailsBridge = await SetupWebViewAsync(DetailsView, "details.html", b => RegisterCommands(b, isList: false));

        BuildShellTree();
    }

    /// <summary>
    /// WebView2 を共通設定（シム注入・仮想ホスト・画像配信）でセットアップし、
    /// コマンドを登録して指定ページへ遷移、IPC ブリッジを返す。
    /// list/details/イメージウィンドウで共用。
    /// </summary>
    private async Task<IpcBridge> SetupWebViewAsync(
        Microsoft.Web.WebView2.Wpf.WebView2 view,
        string page,
        Action<IpcBridge> registerCommands)
    {
        await view.EnsureCoreWebView2Async(_env);
        var core = view.CoreWebView2;

        // Tauri 互換シムをドキュメント生成時に注入（既存フロント流用）。
        await core.AddScriptToExecuteOnDocumentCreatedAsync(IpcBridge.BootstrapScript);

        // WebAssets を仮想ホストで配信。
        core.SetVirtualHostNameToFolderMapping(
            "app.viewer", _webAssetsPath, CoreWebView2HostResourceAccessKind.Allow);

        // 画像をディスクから直接配信（仕様 §3：キャッシュなし・WebView2 がデコード）。
        core.AddWebResourceRequestedFilter($"https://{FileHost}/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += (s, args) => OnFileResourceRequested(_env!, args);

        var bridge = new IpcBridge(core, Dispatcher);
        registerCommands(bridge);

        core.Settings.AreDevToolsEnabled = true;
        // 既定のブラウザ右クリックメニューは無効化（独自コンテキストメニューを使う・仕様 §2.4）。
        core.Settings.AreDefaultContextMenusEnabled = false;
        // ブラウザ用アクセラレータキー（F5/Ctrl+R の再読込、Ctrl+P 印刷、ブラウザズーム等）を無効化。
        // F5 で WebView ページが再読込されて一覧が空になる事故を防ぐ（F5 は JS 側でフォルダー更新に割当）。
        core.Settings.AreBrowserAcceleratorKeysEnabled = false;

        core.Navigate($"{AppHost}/{page}");
        return bridge;
    }

    // ---- 画像配信（https://file.viewer/raw?p=<urlencoded full path>） ----
    // 読み込み（書庫展開・ファイル読み・TIFF変換）はバックグラウンドで行い UI を固めない（NIO）。
    // GetDeferral でレスポンス確定を遅延し、await 後（UIスレッド）にレスポンスを生成する。
    private async void OnFileResourceRequested(CoreWebView2Environment env, CoreWebView2WebResourceRequestedEventArgs args)
    {
        var deferral = args.GetDeferral();
        try
        {
            var uriStr = args.Request.Uri;
            var (bytes, mime) = await Task.Run(() => ReadImageBytes(uriStr));
            if (bytes == null)
                args.Response = env.CreateWebResourceResponse(null, 404, "Not Found", "");
            else
                args.Response = env.CreateWebResourceResponse(
                    new MemoryStream(bytes), 200, "OK", $"Content-Type: {mime}\r\nCache-Control: no-store");
        }
        catch
        {
            try { args.Response = env.CreateWebResourceResponse(null, 500, "Error", ""); } catch { }
        }
        finally
        {
            deferral.Complete();
        }
    }

    /// <summary>リクエスト URI から画像バイト列と MIME を読む（バックグラウンドスレッドで実行）。
    /// 書庫内画像（?a=&i=）はメモリ展開、通常ファイル（?p=）は読み切り。TIFF は PNG 変換。
    /// ファイルハンドルは保持しない（表示中でも削除/移動可・仕様 §3）。</summary>
    private static (byte[]? bytes, string mime) ReadImageBytes(string uriStr)
    {
        try
        {
            var uri = new Uri(uriStr);
            // t=<最大辺px> が付いていれば一覧サムネイル要求＝縮小デコードして配信（スクロール時の
            // 大画像デコード/描画によるカクつきを防ぐ）。付いていなければビューワー等のフル表示。
            var thumbMax = ParseThumb(uri.Query);
            var archive = QueryParam(uri.Query, "a");
            if (!string.IsNullOrEmpty(archive))
            {
                var inner = QueryParam(uri.Query, "i") ?? "";
                var bytes = ArchiveService.ReadEntry(archive, inner);
                if (bytes == null) return (null, "");
                if (thumbMax > 0)
                {
                    var thumb = ImageTranscode.MakeThumbnail(bytes, thumbMax);
                    if (thumb != null) return (thumb, "image/png");
                }
                var aMime = MimeOf(inner);
                if (FileTypes.NeedsTranscode(inner))
                {
                    var png = ImageTranscode.TiffToPng(bytes);
                    if (png != null) { bytes = png; aMime = "image/png"; }
                }
                return (bytes, aMime);
            }

            var path = QueryParam(uri.Query, "p");
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) return (null, "");
            var fileBytes = File.ReadAllBytes(path);
            if (thumbMax > 0)
            {
                var thumb = ImageTranscode.MakeThumbnail(fileBytes, thumbMax);
                if (thumb != null) return (thumb, "image/png");
            }
            var mime = MimeOf(path);
            if (FileTypes.NeedsTranscode(path))
            {
                var png = ImageTranscode.TiffToPng(fileBytes);
                if (png != null) { fileBytes = png; mime = "image/png"; }
            }
            return (fileBytes, mime);
        }
        catch
        {
            return (null, "");
        }
    }

    /// <summary>クエリ文字列（"?p=...&..."）から指定キーの値を取り出す（System.Web 非依存）。</summary>
    private static string? QueryParam(string query, string key)
    {
        if (string.IsNullOrEmpty(query)) return null;
        var q = query.StartsWith('?') ? query[1..] : query;
        foreach (var pair in q.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var eq = pair.IndexOf('=');
            if (eq < 0) continue;
            if (pair[..eq] == key)
                return System.Net.WebUtility.UrlDecode(pair[(eq + 1)..]);
        }
        return null;
    }

    /// <summary>クエリの t=&lt;最大辺px&gt;（一覧サムネイル要求）を取り出す。無ければ 0。</summary>
    private static int ParseThumb(string query)
    {
        var t = QueryParam(query, "t");
        if (!string.IsNullOrEmpty(t) && int.TryParse(t, out var n) && n > 0)
            return Math.Clamp(n, 16, 1024);
        return 0;
    }

    private static string MimeOf(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".jpg" or ".jpeg" => "image/jpeg",
        ".png" => "image/png",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".bmp" => "image/bmp",
        ".tif" or ".tiff" => "image/tiff",
        _ => "application/octet-stream",
    };

    // ---- コマンド登録（仕様 §0 のIPC層） ----
    private void RegisterCommands(IpcBridge bridge, bool isList)
    {
        // 列挙系
        bridge.Register("get_files", async args =>
        {
            var sort = Str(args, "sort");
            if (string.IsNullOrEmpty(sort)) sort = _settings.SortMode;
            var path = Str(args, "path");
            // 列挙はバックグラウンド（遅い UNC / ネットワークドライブでも UI を固めない）。
            return await Task.Run<object?>(() => ListingService.GetFiles(path, sort));
        });
        // 表示設定（メニューバーの現在値）。一覧/ビューワーが起動時に取得する。
        bridge.Register("get_view_settings", _ => ViewSettingsPayload());
        // 表示設定の更新（メニュー廃止に伴い、各ペインのコントロールから直接設定・保存する）。
        bridge.Register("set_sort", args => { _settings.SortMode = Str(args, "mode"); SettingsService.Save(_settings); return (object?)null; });
        bridge.Register("set_icon_size", args => { if (args.TryGetProperty("size", out var v) && v.TryGetDouble(out var d)) { _settings.IconSize = Math.Clamp(d, 40, 400); SettingsService.Save(_settings); } return (object?)null; });
        bridge.Register("set_view_count", args => { if (args.TryGetProperty("count", out var v) && v.TryGetInt32(out var n)) { _settings.ViewCount = Math.Clamp(n, 1, 16); SettingsService.Save(_settings); } return (object?)null; });
        bridge.Register("set_layout", args => { var m = Str(args, "mode"); if (!string.IsNullOrEmpty(m)) { _settings.LayoutMode = m; SettingsService.Save(_settings); } return (object?)null; });
        bridge.Register("set_reading_rtl", args => { _settings.ReadingRtl = Bool(args, "rtl"); SettingsService.Save(_settings); return (object?)null; });
        bridge.Register("set_trim", args => { _settings.Trim = Bool(args, "trim"); SettingsService.Save(_settings); return (object?)null; });
        bridge.Register("open_shortcuts", _ => { OpenShortcutsWindow(); return (object?)null; });

        // 設定ウィンドウ（ツール → 設定）
        bridge.Register("get_settings", _ => SettingsPayload());
        bridge.Register("set_setting", args => { ApplySetting(args); return (object?)null; });
        bridge.Register("get_startup_folder", _ => (object?)ResolveStartupFolder()); // 起動時に一覧が取得
        // ビューワが表示中画像を通知 → 設定ONなら一覧でその画像を選択（書庫内は inner path）。
        bridge.Register("viewer_current_image", args =>
        {
            if (_settings.SyncListSelection)
            {
                var ap = Str(args, "archivePath");
                var sel = string.IsNullOrEmpty(ap) ? Str(args, "path") : Str(args, "innerPath");
                if (!string.IsNullOrEmpty(sel)) _listBridge?.EmitEvent("select_image", new { path = sel });
            }
            return (object?)null;
        });
        bridge.Register("pick_folder", _ =>
        {
            var dlg = new Microsoft.Win32.OpenFolderDialog { Title = "起動時に開くフォルダを選択" };
            return dlg.ShowDialog(this) == true ? (object?)dlg.FolderName : null;
        });
        bridge.Register("get_file_info", args => (object?)ListingService.GetFileInfo(Str(args, "path")));
        bridge.Register("get_drives", _ => (object?)ListingService.GetDrives());
        bridge.Register("get_folder_tree", args => (object?)ListingService.GetFolderTree(Str(args, "path")));

        // 書庫の閲覧（仕様 §5）。
        bridge.Register("get_archive_files", args =>
            (object?)ArchiveService.ListEntries(Str(args, "archivePath"), Str(args, "innerPath")));
        // 書庫サムネイル用：中の1枚目の画像の内部パスを返す（書庫を開くので背景で実行）。
        bridge.Register("get_archive_first_image", async args =>
        {
            var ap = Str(args, "archivePath");
            return await Task.Run<object?>(() => ArchiveService.FirstImageEntry(ap));
        });
        // フォルダーサムネイル用：直下の1枚目の画像のフルパスを返す（列挙は背景で実行）。
        bridge.Register("get_folder_first_image", async args =>
        {
            var p = Str(args, "path");
            return await Task.Run<object?>(() => ListingService.FirstImageEntry(p));
        });

        // タグフィルター（仕様 §7・元 viewer 互換）。フォルダー内全画像の
        // ポジ/ネガ/モデルを抽出して [{path, positive, negative, model}] で返す。
        // タグ分割・状態管理・絞り込みは詳細ペイン(JS)が元アプリと同一ロジックで行う。
        bridge.Register("get_all_image_prompts", async _ =>
        {
            var folder = _watchedFolder;
            return await Task.Run<object?>(() => GetAllImagePrompts(folder));
        });
        // 詳細ペインが算出した可視パス集合を一覧ペインへ中継する（パネル間は host 経由）。
        bridge.Register("apply_tag_filter", args =>
        {
            _listBridge?.EmitEvent("tag_filter", new { active = Bool(args, "active"), paths = StrArray(args, "paths") });
            return (object?)null;
        });

        // 生成AIメタデータ抽出（仕様 §6）。重い場合があるのでバックグラウンドで実行。
        bridge.Register("get_image_details", async args =>
        {
            var ap = Str(args, "archivePath");
            var inner = Str(args, "innerPath");
            var path = Str(args, "path");
            return await Task.Run<object?>(() =>
            {
                if (!string.IsNullOrEmpty(ap))
                {
                    var bytes = ArchiveService.ReadEntry(ap, inner);
                    return bytes == null ? null : (object?)AiImageMetadataService.ExtractFromBytes(bytes);
                }
                return (object?)AiImageMetadataService.Extract(path);
            });
        });

        // ファイル操作（削除はシェル IFileOperation でごみ箱へ・仕様 §2.0/A.2）
        bridge.Register("move_to_trash", args => (object?)ShellFileOperations.Recycle(StrArray(args, "paths"), Hwnd));
        // ペイン内 DnD：選択ファイルを宛先フォルダーへ移動（Ctrl ならコピー）。シェル委譲で
        // 競合解決・取り消し(Ctrl+Z)も Explorer と一致（仕様 §2.0/§2.2）。
        bridge.Register("drop_move_files", args =>
        {
            var paths = StrArray(args, "paths");
            var dest = Str(args, "destination");
            if (paths.Length == 0 || string.IsNullOrEmpty(dest) || !Directory.Exists(dest)) return (object?)null;
            if (Bool(args, "copy")) ShellFileOperations.Copy(paths, dest, Hwnd, renameOnCollision: false);
            else ShellFileOperations.Move(paths, dest, Hwnd);
            return (object?)null;
        });
        bridge.Register("rename_file", args =>
        {
            var oldPath = Str(args, "oldPath");
            var newName = Str(args, "newName");
            FileOpsService.ValidateNewName(newName); // 不正名は例外→フロントでトースト
            ShellFileOperations.Rename(oldPath, newName, Hwnd); // シェル委譲（取り消し可・仕様 §2.0）
            return (object?)null;
        });

        // クリップボード（切り取り/コピー/貼り付け。Explorer 互換・仕様 §2.1）
        bridge.Register("copy_files_to_clipboard", args =>
        {
            CopyFilesToClipboard(StrArray(args, "paths"), Bool(args, "cut"));
            return (object?)null;
        });
        bridge.Register("get_files_from_clipboard", _ =>
            (object?)System.Windows.Clipboard.GetFileDropList().Cast<string>().ToArray());
        bridge.Register("paste_from_clipboard", args => (object?)PasteFromClipboard(Str(args, "destination")));

        // コンテキストメニュー用（仕様 §2.4）
        bridge.Register("open_in_explorer", args => { OpenInExplorer(Str(args, "path")); return (object?)null; });
        bridge.Register("open_with_default_app", args => { OpenWithDefaultApp(Str(args, "path")); return (object?)null; });
        bridge.Register("copy_text_to_clipboard", args => { System.Windows.Clipboard.SetText(Str(args, "text")); return (object?)null; });
        bridge.Register("create_folder", args => (object?)FileOpsService.CreateFolder(Str(args, "parentPath")));
        bridge.Register("touch_file", args => (object?)FileOpsService.Touch(Str(args, "path")));

        // フルのシェルコンテキストメニュー（「一般メニュー」・仕様 §2.3）。カーソル位置に表示。
        bridge.Register("show_context_menu", args => { ShellContextMenu.Show(StrArray(args, "paths"), Hwnd); return (object?)null; });

        // ショートカット設定（仕様 §8）。shortcuts.json に保存。保存時は全ウィンドウへ
        // 'shortcuts-updated' を配信して shortcut-dispatch.js をライブ再読込させる。
        bridge.Register("load_shortcuts", _ => (object?)ShortcutsService.Load());
        bridge.Register("save_shortcuts", args =>
        {
            if (args.ValueKind == JsonValueKind.Object && args.TryGetProperty("settings", out var settings))
            {
                ShortcutsService.Save(settings);
                _listBridge?.EmitEvent("shortcuts-updated", null);
                _detailsBridge?.EmitEvent("shortcuts-updated", null);
                _imageBridge?.EmitEvent("shortcuts-updated", null);
            }
            return (object?)null;
        });

        // 他アプリへのネイティブ DnD（仕様 §2.2）。UI スレッドで実行。
        bridge.Register("start_native_drag", args =>
            Task.FromResult<object?>(StartNativeDrag(StrArray(args, "paths"), Bool(args, "defaultMove"))));

        // ドラッグオーバー時の copy/move 判定用（仕様 §2.2）。
        bridge.Register("get_modifier_state", _ =>
        {
            var mods = Keyboard.Modifiers;
            return (object?)new ModifierState
            {
                Shift = mods.HasFlag(ModifierKeys.Shift),
                Ctrl = mods.HasFlag(ModifierKeys.Control),
                Alt = mods.HasFlag(ModifierKeys.Alt),
            };
        });

        if (isList)
        {
            // 一覧→ホスト→詳細ペインへ選択を中継（複数 WebView2 はホスト経由・仕様 §0）。
            // 書庫内のときは archivePath も中継（詳細ペインが書庫内画像を解析できるように）。
            bridge.Register("selection_changed", args =>
            {
                var paths = StrArray(args, "paths");
                var archivePath = Str(args, "archivePath");
                _detailsBridge?.EmitEvent("show_details", new { paths, archive_path = archivePath });
                return (object?)null;
            });

            // フォルダーを開いた（ダブルクリック等）→ ツリー選択の追従（将来）。
            bridge.Register("host_navigated", _ => (object?)null);

            // 表示中フォルダーの監視対象を更新（仕様 §1.5）。書庫内は path 空で停止。
            bridge.Register("watch_folder", args => { WatchFolder(Str(args, "path")); return (object?)null; });

            // 画像を開く（イメージウィンドウ。仕様 §4：1ウィンドウのみ）。
            // 書庫内画像のときは archivePath / innerPath を伴う（仕様 §5）。
            bridge.Register("open_image", async args =>
            {
                await OpenImage(Str(args, "path"), Str(args, "archivePath"), Str(args, "innerPath"), StrArray(args, "paths"));
                return (object?)null;
            });

            // タグフィルター変更時に、開いているビューワの画像リストも更新する（仕様 §4.5/§7）。
            // ビューワ未起動なら何もしない。書庫表示中かどうかはビューワ側が判定して無視する。
            bridge.Register("update_viewer_images", args =>
            {
                if (_imageWindow != null)
                    _imageBridge?.EmitEvent("filter_images_changed", new { paths = StrArray(args, "paths") });
                return (object?)null;
            });
        }
    }

    // ---- イメージウィンドウ（仕様 §4 / D.7：当面1個のみ・normal レイアウト） ----
    // <paramref name="visiblePaths"/> は一覧ペインが渡す「現在表示中の画像パス（タグフィルター
    // 適用後・ソート順）」。ビューワの切替/先読みがこの集合だけを巡るよう、これを画像リストの
    // 単一の真実源にする（仕様 §4.5/§7）。空のときのみフォルダー/書庫を直接列挙してフォールバック。
    private async Task OpenImage(string path, string archivePath, string innerPath, string[] visiblePaths)
    {
        List<object> images;
        int index;

        if (!string.IsNullOrEmpty(archivePath))
        {
            var inner = visiblePaths.Length > 0
                ? visiblePaths
                : ArchiveService.ListEntries(archivePath, ParentInner(innerPath))
                    .Where(e => !e.IsDir && e.IsImage).Select(e => e.Path).ToArray();
            images = inner.Select(ip => (object)new
            {
                path = ip, name = InnerName(ip), archive_path = archivePath, inner_path = ip,
            }).ToList();
            index = Array.FindIndex(inner, ip => string.Equals(ip, innerPath, StringComparison.OrdinalIgnoreCase));
        }
        else
        {
            if (string.IsNullOrEmpty(path)) return;
            var list = visiblePaths.Length > 0
                ? visiblePaths
                : ListingService.GetFiles(Path.GetDirectoryName(path) ?? "")
                    .Where(f => !f.IsDir && f.IsImage).Select(f => f.Path).ToArray();
            images = list.Select(p => (object)new { path = p, name = Path.GetFileName(p) }).ToList();
            index = Array.FindIndex(list, p => string.Equals(p, path, StringComparison.OrdinalIgnoreCase));
        }
        if (index < 0) index = 0;

        _pendingViewerPayload = new
        {
            images,
            index,
            // 新規に開く枚数：「決まった枚数」なら固定値、そうでなければ前回の枚数(ViewCount)。
            view_count = _settings.ImageCountMode == "fixed" ? _settings.ImageCountFixed : _settings.ViewCount,
            reading_rtl = _settings.ReadingRtl,
            trim = _settings.Trim,
            layout = _settings.LayoutMode,
            end_marker = _settings.EndMarker,
            loop = _settings.LoopNavigation,
            preload = _settings.PreloadCount,
        };

        if (_imageWindow == null)
        {
            _imageWindow = new ImageWindow { Owner = this };

            // 保存済みのサイズ/位置を復元（仕様 §4 / §9）。
            _imageWindow.Width = _settings.ImageWindowWidth;
            _imageWindow.Height = _settings.ImageWindowHeight;
            if (_settings.ImageWindowLeft is double il && _settings.ImageWindowTop is double it)
            {
                _imageWindow.WindowStartupLocation = WindowStartupLocation.Manual;
                _imageWindow.Left = il;
                _imageWindow.Top = it;
            }
            if (_settings.ImageWindowMaximized) _imageWindow.WindowState = WindowState.Maximized;

            // 閉じる際にサイズ/位置を保存（最大化時は復元サイズを保持）。
            _imageWindow.Closing += (s, _) => SaveImageWindowBounds((ImageWindow)s!);
            _imageWindow.Closed += (_, _) => { _imageWindow = null; _imageBridge = null; _pendingViewerPayload = null; };
            _imageWindow.Show();

            // 共有コマンド（load_shortcuts / get_image_details / move_to_trash /
            // copy_files_to_clipboard 等）＋ビューワ専用コマンドの両方を登録する。
            // これが無いとビューワのショートカット上書きが読めず（常に既定にフォールバック）、
            // 詳細オーバーレイ・削除・コピーも失敗する。
            _imageBridge = await SetupWebViewAsync(_imageWindow.View, "viewer.html", b =>
            {
                RegisterCommands(b, isList: false);
                RegisterViewerCommands(b);
            });

            // 表示直後は WebView2 の Web 内容にキーボードフォーカスが無く、クリックするまで
            // keydown（=ショートカット）が効かない。読み込み完了時に WebView へフォーカスを移す。
            var view = _imageWindow.View;
            void FocusWhenLoaded(object? s, CoreWebView2NavigationCompletedEventArgs e)
            {
                view.CoreWebView2.NavigationCompleted -= FocusWhenLoaded;
                Dispatcher.BeginInvoke(() => { _imageWindow?.Activate(); view.Focus(); });
            }
            view.CoreWebView2.NavigationCompleted += FocusWhenLoaded;
        }
        else
        {
            // 既存ウィンドウを再利用（1個のみ・D.7）。新しい画像リストを通知。
            if (_imageWindow.WindowState == WindowState.Minimized) _imageWindow.WindowState = WindowState.Normal;
            _imageWindow.Activate();
            _imageWindow.View.Focus(); // 再表示時もフォーカスを WebView へ
            _imageBridge?.EmitEvent("load_images", _pendingViewerPayload);
        }
    }

    // 画像ウィンドウのサイズ/位置を設定に保存（最大化時は復元サイズを保持）。
    private void SaveImageWindowBounds(ImageWindow w)
    {
        // 全画面表示中に閉じた場合は設定を更新しない（全画面前のサイズを保持・ユーザー要望）。
        if (w.IsFullscreen) return;

        if (w.WindowState == WindowState.Maximized)
        {
            _settings.ImageWindowMaximized = true;
            var rb = w.RestoreBounds;
            if (!rb.IsEmpty)
            {
                _settings.ImageWindowWidth = rb.Width;
                _settings.ImageWindowHeight = rb.Height;
                _settings.ImageWindowLeft = rb.Left;
                _settings.ImageWindowTop = rb.Top;
            }
        }
        else
        {
            _settings.ImageWindowMaximized = false;
            _settings.ImageWindowWidth = w.Width;
            _settings.ImageWindowHeight = w.Height;
            _settings.ImageWindowLeft = w.Left;
            _settings.ImageWindowTop = w.Top;
        }
        SettingsService.Save(_settings);
    }

    private void RegisterViewerCommands(IpcBridge bridge)
    {
        // viewer ページが起動完了時に呼ぶ。初期の画像リスト＋インデックスを返す。
        bridge.Register("viewer_ready", _ => _pendingViewerPayload);

        // 画像のファイル情報（詳細オーバーレイ用。メタデータ本実装は §6 で後続）。
        bridge.Register("get_file_info", args => (object?)ListingService.GetFileInfo(Str(args, "path")));

        // フルスクリーン切替（ホスト側で window を制御。仕様 §4.3）。
        bridge.Register("toggle_fullscreen", args =>
        {
            var on = Bool(args, "fullscreen");
            _imageWindow?.SetFullscreen(on);
            // ウィンドウサイズ確定後にビューワへ再レイアウトを通知（画像をフィットし直す）。
            // resize イベントが確実に発火しない環境の保険。レイアウト確定後に出すため低優先で投げる。
            Dispatcher.BeginInvoke(new Action(() => _imageBridge?.EmitEvent("relayout", null)),
                System.Windows.Threading.DispatcherPriority.Background);
            return (object?)null;
        });

        // ウィンドウを閉じる（仕様 §4.3）。
        bridge.Register("close_viewer", _ =>
        {
            _imageWindow?.Close();
            return (object?)null;
        });

        // タイトル更新（現在画像のパス等）。
        bridge.Register("set_viewer_title", args =>
        {
            if (_imageWindow != null) _imageWindow.Title = Str(args, "title");
            return (object?)null;
        });
    }

    private string StartNativeDrag(string[] paths, bool defaultMove)
    {
        if (paths.Length == 0) return "none";

        // WebMessageReceived は WebView2 生成スレッド（＝UI）で発火するためここは UI スレッド。
        var data = new DataObject();
        var col = new System.Collections.Specialized.StringCollection();
        foreach (var p in paths) col.Add(p);
        data.SetFileDropList(col);

        var allowed = DragDropEffects.Copy | DragDropEffects.Move;
        // copy/move の最終決定はドロップ時の修飾キーで OS（ターゲット）が行う。
        var effect = DragDrop.DoDragDrop(ListView, data, allowed);

        if (effect.HasFlag(DragDropEffects.Move)) return "move";
        if (effect.HasFlag(DragDropEffects.Copy)) return "copy";
        return "none";
    }

    // ---- シェル名前空間ツリー（仕様 §1.2 / C.6） ----
    private void BuildShellTree()
    {
        FolderTree.Items.Clear();
        foreach (var node in ShellTree.GetRoots())
            FolderTree.Items.Add(CreateShellNode(node));
    }

    private TreeViewItem CreateShellNode(ShellNode node)
    {
        var item = new TreeViewItem { Header = MakeTreeHeader(node), Tag = node };
        if (node.HasChildren) item.Items.Add(Dummy); // 遅延展開用ダミー
        return item;
    }

    // 「PC」（マイコンピューター）の解析名 CLSID。ドライブの親としてツリー同期の起点に使う。
    private const string ThisPcClsid = "::{20D04FE0-3AEA-1069-A2D8-08002B30309D}";

    // 一覧で開いているフォルダーをツリーで選択する（設定「開いているフォルダをツリーで選択する」）。
    // PC ルートから祖先チェーン（ドライブ直下→目的）を辿り、必要に応じて子を読み込み・展開して選択。
    private async Task SelectInTree(string targetPath)
    {
        try
        {
            if (string.IsNullOrEmpty(targetPath) || !Directory.Exists(targetPath)) return;

            // 既に目的パスが選択済みなら何もしない（ループ防止・無駄回避）。
            if (FolderTree.SelectedItem is TreeViewItem sel && sel.Tag is ShellNode selNode
                && PathEquals(selNode.FileSystemPath, targetPath)) return;

            // ドライブ直下 .. 目的フォルダー の祖先チェーン。
            var chain = new List<string>();
            for (var d = new DirectoryInfo(targetPath); d != null; d = d.Parent) chain.Add(d.FullName);
            chain.Reverse();

            var pc = FolderTree.Items.OfType<TreeViewItem>().FirstOrDefault(i =>
                i.Tag is ShellNode n && (n.ParsingName ?? "").Contains(ThisPcClsid, StringComparison.OrdinalIgnoreCase));
            if (pc == null) return;

            var current = pc;
            foreach (var seg in chain)
            {
                await EnsureChildrenLoaded(current);
                var child = current.Items.OfType<TreeViewItem>().FirstOrDefault(i =>
                    i.Tag is ShellNode n && PathEquals(n.FileSystemPath, seg));
                if (child == null) return; // 見つからなければ諦める
                current = child;
            }

            _suppressTreeNavigate = true;
            try { current.IsSelected = true; current.BringIntoView(); }
            finally { _suppressTreeNavigate = false; }
        }
        catch { /* 同期失敗は無視 */ }
    }

    // ツリーノードの子を（未読込なら）読み込んでから展開する。
    private async Task EnsureChildrenLoaded(TreeViewItem item)
    {
        if (item.Tag is not ShellNode node) return;
        if (item.Items.Count == 1 && item.Items[0] as string == Dummy)
        {
            item.Items.Clear();
            var children = await node.GetChildrenAsync();
            foreach (var c in children) item.Items.Add(CreateShellNode(c));
        }
        item.IsExpanded = true;
    }

    private static bool PathEquals(string? a, string b)
        => !string.IsNullOrEmpty(a) && string.Equals(a!.TrimEnd('\\'), b.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);

    // ツリーノードの見出し：シェルアイコン＋表示名（全ノードでアイコン表示・仕様 §1.2）。
    private static StackPanel MakeTreeHeader(ShellNode node)
    {
        var sp = new StackPanel { Orientation = Orientation.Horizontal };
        var icon = node.GetIcon();
        if (icon != null)
        {
            sp.Children.Add(new Image
            {
                Source = icon, Width = 16, Height = 16,
                Margin = new Thickness(0, 0, 6, 0),
                SnapsToDevicePixels = true,
                VerticalAlignment = VerticalAlignment.Center,
            });
        }
        sp.Children.Add(new TextBlock { Text = node.DisplayName, VerticalAlignment = VerticalAlignment.Center });
        return sp;
    }

    private async void FolderTree_Expanded(object sender, RoutedEventArgs e)
    {
        if (e.OriginalSource is not TreeViewItem item) return;
        if (item.Items.Count != 1 || item.Items[0] as string != Dummy) return; // 展開済みは無視
        if (item.Tag is not ShellNode node) return;

        // 列挙はバックグラウンド（ネットワーク等でも UI を固めない）。待機中は「読み込み中…」を表示。
        item.Items.Clear();
        item.Items.Add(new TreeViewItem { Header = "読み込み中…", IsEnabled = false, Focusable = false });
        try
        {
            var children = await node.GetChildrenAsync();
            item.Items.Clear();
            foreach (var child in children) item.Items.Add(CreateShellNode(child));
        }
        catch { item.Items.Clear(); }
    }

    private async void FolderTree_SelectedItemChanged(object sender, RoutedPropertyChangedEventArgs<object> e)
    {
        if (_suppressTreeNavigate) return; // プログラムからの選択（一覧→ツリー同期）では一覧を動かさない
        if (e.NewValue is not TreeViewItem item || item.Tag is not ShellNode node) return;

        // 実フォルダー（ファイルシステムパスあり）はそのフォルダーへナビゲート。
        var path = node.FileSystemPath;
        if (!string.IsNullOrEmpty(path) && Directory.Exists(path))
        {
            _listBridge?.EmitEvent("navigate", new { path });
            return;
        }

        // 仮想フォルダー（PC/ホーム/ギャラリー/ネットワーク等）はパスが無い。Explorer で
        // 「PC」を開くとドライブ一覧が出るのと同様、子のうち実フォルダーを一覧に表示する。
        // 列挙はバックグラウンド。待機中は一覧にローディングを表示。
        _listBridge?.EmitEvent("list_loading", new { });
        try
        {
            var children = await node.GetChildrenAsync();
            var folders = children
                .Where(c => !string.IsNullOrEmpty(c.FileSystemPath) && Directory.Exists(c.FileSystemPath))
                .Select(c => (object)new { path = c.FileSystemPath, name = c.DisplayName })
                .ToList();
            _listBridge?.EmitEvent("show_folders", new { title = node.DisplayName, folders });
        }
        catch
        {
            _listBridge?.EmitEvent("show_folders", new { title = node.DisplayName, folders = Array.Empty<object>() });
        }
    }

    /// <summary>メインウィンドウのハンドル（シェル操作のダイアログ親に使う）。</summary>
    private IntPtr Hwnd => new System.Windows.Interop.WindowInteropHelper(this).Handle;

    // ---- タイトルバー（フレーム）配色：Windows 11 の DWM で指定（OS設定に依存しない） ----
    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    private const int DWMWA_BORDER_COLOR = 34;   // ウィンドウ枠線の色（Win11 22000+）
    private const int DWMWA_CAPTION_COLOR = 35;  // タイトルバー背景色
    private const int DWMWA_TEXT_COLOR = 36;     // タイトル文字色

    // COLORREF は 0x00BBGGRR。クリーム配色に合わせる。Windows 10 では失敗するが無害。
    private void ApplyTitleBarTheme()
    {
        var hwnd = Hwnd;
        if (hwnd == IntPtr.Zero) return;
        int caption = ColorRef(0xF0, 0xEE, 0xE6); // 背景クリーム
        int text = ColorRef(0x2B, 0x2A, 0x27);    // 文字（暖色寄りの黒）
        int border = ColorRef(0xE0, 0xDC, 0xD0);  // 枠線
        try
        {
            DwmSetWindowAttribute(hwnd, DWMWA_CAPTION_COLOR, ref caption, sizeof(int));
            DwmSetWindowAttribute(hwnd, DWMWA_TEXT_COLOR, ref text, sizeof(int));
            DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, ref border, sizeof(int));
        }
        catch { /* 非対応OSは無視 */ }
    }

    private static int ColorRef(byte r, byte g, byte b) => r | (g << 8) | (b << 16);

    // ---- フォルダー監視（仕様 §1.5） ----
    private void WatchFolder(string path)
    {
        // 同じフォルダーなら何もしない。
        if (string.Equals(path, _watchedFolder, StringComparison.OrdinalIgnoreCase)) return;

        _watcher?.Dispose();
        _watcher = null;
        _watchedFolder = "";

        if (string.IsNullOrEmpty(path) || !Directory.Exists(path)) return;
        _lastFolder = path; // 「前回開いていたフォルダ」として記録（終了時に保存）
        if (_settings.SyncTreeSelection) _ = SelectInTree(path); // 開いているフォルダをツリーで選択

        try
        {
            var w = new FileSystemWatcher(path)
            {
                IncludeSubdirectories = false,
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName
                             | NotifyFilters.LastWrite | NotifyFilters.Size,
            };
            w.Created += OnFsEvent;
            w.Deleted += OnFsEvent;
            w.Renamed += OnFsEvent;
            w.Changed += OnFsEvent;
            w.EnableRaisingEvents = true;
            _watcher = w;
            _watchedFolder = path;
        }
        catch { /* アクセス不可等は監視なしで継続 */ }

        // 詳細ペインのタグフィルターへフォルダー変更を通知（仕様 §7）。
        _detailsBridge?.EmitEvent("folder_changed", new { path = _watchedFolder });
    }

    // FileSystemWatcher のイベントはスレッドプールで発火。UI スレッドでデバウンスして一覧へ通知。
    private void OnFsEvent(object sender, FileSystemEventArgs e)
    {
        Dispatcher.BeginInvoke(() =>
        {
            _fsDebounce ??= new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(300) };
            _fsDebounce.Tick -= FsDebounceTick;
            _fsDebounce.Tick += FsDebounceTick;
            _fsDebounce.Stop();
            _fsDebounce.Start();
        });
    }

    private void FsDebounceTick(object? sender, EventArgs e)
    {
        _fsDebounce?.Stop();
        _listBridge?.EmitEvent("fs_changed", new { path = _watchedFolder });
    }

    // ---- タグフィルター（仕様 §7・元 viewer 互換） ----
    /// <summary>フォルダー内全画像のポジ/ネガ/モデルを抽出して返す。
    /// タグ分割・状態管理・絞り込みは詳細ペイン(JS)が元アプリと同一ロジックで行う。</summary>
    private object GetAllImagePrompts(string folder)
    {
        if (string.IsNullOrEmpty(folder) || !Directory.Exists(folder))
            return Array.Empty<object>();

        var list = new List<object>();
        foreach (var f in ListingService.GetFiles(folder).Where(x => !x.IsDir && x.IsImage))
        {
            string positive = "", negative = "", model = "";
            try
            {
                var md = AiImageMetadataService.Extract(f.Path);
                if (md is { HasAiData: true })
                {
                    positive = md.Positive ?? "";
                    negative = md.Negative ?? "";
                    model = md.Model ?? "";
                }
            }
            catch { /* 壊れた画像はタグなし扱い */ }
            list.Add(new { path = f.Path, positive, negative, model });
        }
        return list;
    }

    // ---- クリップボード（仕様 §2.1） ----
    private void CopyFilesToClipboard(string[] paths, bool cut)
    {
        if (paths.Length == 0) return;
        var data = new System.Windows.DataObject();
        var coll = new System.Collections.Specialized.StringCollection();
        coll.AddRange(paths);
        data.SetFileDropList(coll);

        // "Preferred DropEffect": DROPEFFECT_MOVE(2)=切り取り / DROPEFFECT_COPY(1)=コピー。
        var ms = new MemoryStream();
        ms.Write(BitConverter.GetBytes(cut ? 2 : 1), 0, 4);
        ms.Position = 0;
        data.SetData("Preferred DropEffect", ms);

        System.Windows.Clipboard.SetDataObject(data, true);
    }

    private object PasteFromClipboard(string destination)
    {
        if (string.IsNullOrEmpty(destination) || !System.Windows.Clipboard.ContainsFileDropList())
            return new { count = 0, mode = "noop" };

        var files = System.Windows.Clipboard.GetFileDropList().Cast<string>().ToList();
        if (files.Count == 0) return new { count = 0, mode = "noop" };

        bool move = false;
        var dobj = System.Windows.Clipboard.GetDataObject();
        if (dobj != null && dobj.GetDataPresent("Preferred DropEffect")
            && dobj.GetData("Preferred DropEffect") is MemoryStream pms)
        {
            var b = new byte[4];
            pms.Position = 0;
            if (pms.Read(b, 0, 4) == 4) move = (BitConverter.ToInt32(b, 0) & 2) != 0;
        }

        // 同一ディレクトリ判定。切り取り＆同一フォルダーは何もしない（Explorer と同じ）。
        bool allSameDir = files.All(f =>
            string.Equals(Path.GetDirectoryName(f), destination, StringComparison.OrdinalIgnoreCase));
        if (move && allSameDir) return new { count = 0, mode = "noop" };

        int n;
        if (move)
        {
            n = ShellFileOperations.Move(files, destination, Hwnd);
            System.Windows.Clipboard.Clear(); // 移動済みのソースを参照し続けないように
        }
        else
        {
            // 同一フォルダーへのコピーは自動リネーム（「- コピー」）。別フォルダーは衝突時に
            // Explorer 標準の置換/スキップ ダイアログ（=自動リネームしない）。
            n = ShellFileOperations.Copy(files, destination, Hwnd, renameOnCollision: allSameDir);
        }
        return new { count = n, mode = move ? "move" : "copy" };
    }

    // ---- コンテキストメニュー系（仕様 §2.4） ----
    private static void OpenInExplorer(string path)
    {
        if (string.IsNullOrEmpty(path)) return;
        // エクスプローラーで親フォルダーを開き、対象を選択（Explorer の「対象を表示」）。
        Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{path}\"") { UseShellExecute = true });
    }

    private static void OpenWithDefaultApp(string path)
    {
        if (string.IsNullOrEmpty(path)) return;
        Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
    }

    /// <summary>書庫内パスの親フォルダー（'\' 区切り、ルートは ""）。</summary>
    private static string ParentInner(string innerPath)
    {
        var p = innerPath.Replace('/', '\\').TrimEnd('\\');
        int idx = p.LastIndexOf('\\');
        return idx < 0 ? "" : p[..idx];
    }

    // 書庫内 inner パスの末尾セグメント（表示名）。
    private static string InnerName(string innerPath)
    {
        var p = innerPath.Replace('/', '\\').TrimEnd('\\');
        int idx = p.LastIndexOf('\\');
        return idx < 0 ? p : p[(idx + 1)..];
    }

    // ---- args ヘルパ ----
    private static string Str(JsonElement args, string key)
        => args.ValueKind == JsonValueKind.Object && args.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() ?? "" : "";

    private static bool Bool(JsonElement args, string key)
        => args.ValueKind == JsonValueKind.Object && args.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.True;

    private static string[] StrArray(JsonElement args, string key)
    {
        if (args.ValueKind != JsonValueKind.Object || !args.TryGetProperty(key, out var v) || v.ValueKind != JsonValueKind.Array)
            return Array.Empty<string>();
        var list = new List<string>();
        foreach (var item in v.EnumerateArray())
            if (item.ValueKind == JsonValueKind.String) list.Add(item.GetString() ?? "");
        return list.ToArray();
    }
}
