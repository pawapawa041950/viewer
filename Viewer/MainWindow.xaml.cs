using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;
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

    private string _webAssetsPath = "";
    private CoreWebView2Environment? _env;

    // ---- ファイル一覧ペインのタブ（1タブ=1 WebView2。中央のみタブ化・ツリー/詳細は共有） ----
    // GroupId は将来の分割ビュー（chbrowser 式 PaneLayoutPanel）を見据えた予約。今は全タブ "main"。
    private sealed class TabContext
    {
        public string Id = Guid.NewGuid().ToString("N");
        public string GroupId = "main";
        public Microsoft.Web.WebView2.Wpf.WebView2 View = default!;       // 一覧ペイン
        public IpcBridge? Bridge;                                          // 一覧ペインの IPC
        public Microsoft.Web.WebView2.Wpf.WebView2 DetailsView = default!; // 詳細ペイン（タブごと）
        public IpcBridge? DetailsBridge;                                   // 詳細ペインの IPC
        public Border Chip = default!;       // タブバー上の見出し要素
        public TextBlock TitleText = default!;
        public string Title = "新しいタブ";
        public string InitialFolder = "";    // 生成時に最初に開くフォルダ（空=空タブ）
        public string CurrentFolder = "";    // 現在のディスク上フォルダ（書庫内でも親を保持）
        // フォルダー監視（タブごと・仕様 §1.5）。
        public FileSystemWatcher? Watcher;
        public DispatcherTimer? FsDebounce; // 変更通知のデバウンス（このタブ専用・初回に生成）
        public string WatchedFolder = "";
        public bool Suspended;               // 非アクティブ時に CoreWebView2 をサスペンド中か
        public bool Closed;                  // 破棄済み（以後の遅延コールバックを無効化）
    }

    // 画像ウィンドウの束（単一モード＝共有1個 / タブ別モード＝タブごと）。
    // OwnerTab は逆方向ルーティング（viewer→一覧の選択同期）の宛先。
    private sealed class ImageHost
    {
        public ImageWindow Window = default!;
        public IpcBridge? Bridge;
        public object? PendingPayload;
        public TabContext OwnerTab = default!;
    }

    private readonly List<TabContext> _tabs = new();
    private TabContext? _activeTab;
    private Button? _newTabButton; // タブバー末尾の「＋」（Chrome 風に最後のタブの右隣）

    // タブのドラッグ並べ替え（../chbrowser 参考）。挿入位置は TabInsertionAdorner で表示。
    private TabContext? _dragTab;
    private Point _dragStart;
    private bool _dragMoved;
    private TabInsertionAdorner? _dragAdorner;
    private Border? _dragAdornerChip;
    private bool _dragAdornerAfter;
    private TabContext? _dropTarget;
    private bool _dropAfter;

    // 画像ウィンドウ：単一モードは _sharedImageHost、タブ別モードは _tabImageHosts[tabId]。
    private ImageHost? _sharedImageHost;
    private readonly Dictionary<string, ImageHost> _tabImageHosts = new();

    // ショートカット編集ウィンドウ（仕様 §8：単一インスタンス）。
    private ShortcutsWindow? _shortcutsWindow;
    private SettingsWindow? _settingsWindow;

    private bool _suppressTreeNavigate; // ツリー選択をプログラムから行う間、navigate 再発火を抑止

    private AppSettings _settings = new();

    public MainWindow()
    {
        InitializeComponent();
        _settings = SettingsService.Load();
        ApplySettings(_settings);
        Loaded += OnLoaded;
        Closing += OnClosing;
        // タブ操作のフォールバック：WebView にフォーカスが無い（ツリー等）ときも効くように
        // ウィンドウ側でも既定キーを拾う。WebView にフォーカスがある間は web 内容(JS)側が拾う。
        PreviewKeyDown += MainWindow_PreviewKeyDown;
    }

    private void MainWindow_PreviewKeyDown(object sender, KeyEventArgs e)
    {
        var ctrl = (Keyboard.Modifiers & ModifierKeys.Control) != 0;
        var shift = (Keyboard.Modifiers & ModifierKeys.Shift) != 0;
        if (!ctrl) return;
        if (e.Key == Key.T) { _ = NewTabFromActiveAsync(); e.Handled = true; }
        else if (e.Key == Key.F4) { CloseTab(_activeTab); e.Handled = true; }
        else if (e.Key == Key.Tab) { SwitchTab(shift ? -1 : 1); e.Handled = true; }
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
        Shell.ShellTree.ShowArchivesInTree = s.ShowArchivesInTree; // ツリーに圧縮ファイルを表示
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
        // 起動時復元用：開いている全タブのフォルダ（順序）とアクティブ index を保存。
        _settings.OpenTabs = _tabs.Select(t => t.CurrentFolder ?? "").ToList();
        _settings.ActiveTabIndex = _activeTab != null ? Math.Max(0, _tabs.IndexOf(_activeTab)) : 0;
        var lastFolder = _activeTab?.CurrentFolder; // 互換：単一フォルダも保持
        if (!string.IsNullOrEmpty(lastFolder)) _settings.LastFolder = lastFolder;
        SettingsService.Save(_settings);

        // タブの監視を停止（残留ハンドル防止）。
        foreach (var t in _tabs) { t.Watcher?.Dispose(); t.FsDebounce?.Stop(); }
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

        await SetupWebViewAsync(win.View, "settings.html", b => RegisterCommands(b, null));
        win.View.CoreWebView2.WindowCloseRequested += (_, _) => win.Close();
    }

    private void About_Click(object sender, RoutedEventArgs e)
    {
        var dlg = new AboutDialog { Owner = this };
        dlg.ShowDialog();
    }

    private async void OpenShortcutsWindow()
    {
        if (_shortcutsWindow != null) { _shortcutsWindow.Activate(); return; }

        var win = new ShortcutsWindow { Owner = this };
        _shortcutsWindow = win;
        win.Closed += (_, _) => { if (ReferenceEquals(_shortcutsWindow, win)) _shortcutsWindow = null; };
        win.Show();

        await SetupWebViewAsync(win.View, "shortcuts.html", b => RegisterCommands(b, null));
        // shortcuts.html は window.close() で閉じる → WindowCloseRequested を受けて WPF 側を閉じる。
        win.View.CoreWebView2.WindowCloseRequested += (_, _) => win.Close();
    }

    private object ViewSettingsPayload() => new
    {
        icon_size = _settings.IconSize,
        sort_mode = _settings.SortMode,
        view_count = _settings.ViewCount,
        reading_rtl = _settings.ReadingRtl,
        trim_mode = _settings.TrimMode,
        crop_penalty = _settings.CropPenalty,
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
        show_archives_in_tree = _settings.ShowArchivesInTree,
        image_window_always_on_top = _settings.ImageWindowAlwaysOnTop,
        image_window_per_tab = _settings.ImageWindowPerTab,
    };

    // ---- 全タブ／全画像ウィンドウへのブロードキャスト（複数 WebView2 化に伴う共通化） ----
    private void EmitToAllTabs(string ev, object? payload)
    {
        foreach (var t in _tabs) t.Bridge?.EmitEvent(ev, payload);
    }
    private void EmitToAllImages(string ev, object? payload)
    {
        foreach (var h in AllImageHosts()) h.Bridge?.EmitEvent(ev, payload);
    }

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
                EmitToAllTabs("reload_list", null);
                break;
            case "end_marker":
                _settings.EndMarker = Bool(args, "value");
                SettingsService.Save(_settings);
                EmitToAllImages("view_settings_changed", ViewSettingsPayload());
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
                EmitToAllImages("view_settings_changed", ViewSettingsPayload());
                break;
            case "preload_count":
                if (args.TryGetProperty("value", out var pv) && pv.TryGetInt32(out var pc))
                {
                    _settings.PreloadCount = Math.Clamp(pc, 0, 50);
                    SettingsService.Save(_settings);
                    EmitToAllImages("view_settings_changed", ViewSettingsPayload());
                }
                break;
            case "folder_thumbnails":
                _settings.FolderThumbnails = Bool(args, "value");
                SettingsService.Save(_settings);
                EmitToAllTabs("view_settings_changed", ViewSettingsPayload()); // フラグ更新
                EmitToAllTabs("reload_list_full", null);                       // 全再読込で反映
                break;
            case "archive_thumbnails":
                _settings.ArchiveThumbnails = Bool(args, "value");
                SettingsService.Save(_settings);
                EmitToAllTabs("view_settings_changed", ViewSettingsPayload());
                EmitToAllTabs("reload_list_full", null);
                break;
            case "sync_list_selection":
                _settings.SyncListSelection = Bool(args, "value");
                SettingsService.Save(_settings);
                break;
            case "sync_tree_selection":
                _settings.SyncTreeSelection = Bool(args, "value");
                SettingsService.Save(_settings);
                if (_settings.SyncTreeSelection && !string.IsNullOrEmpty(_activeTab?.CurrentFolder))
                    _ = SelectInTree(_activeTab!.CurrentFolder);
                break;
            case "show_archives_in_tree":
                _settings.ShowArchivesInTree = Bool(args, "value");
                Shell.ShellTree.ShowArchivesInTree = _settings.ShowArchivesInTree;
                SettingsService.Save(_settings);
                BuildShellTree(); // ツリーを再構築して圧縮ファイルの表示/非表示を反映
                break;
            case "image_window_always_on_top":
                _settings.ImageWindowAlwaysOnTop = Bool(args, "value");
                SettingsService.Save(_settings);
                // 開いている全画像ウィンドウに即時反映（Owner の付け外しで常駐/独立を切替）。
                foreach (var h in AllImageHosts())
                    h.Window.Owner = _settings.ImageWindowAlwaysOnTop ? this : null;
                break;
            case "image_window_per_tab":
                _settings.ImageWindowPerTab = Bool(args, "value");
                SettingsService.Save(_settings);
                // 既に開いている画像ウィンドウのモード切替は次回オープン以降に適用（既存はそのまま）。
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

        BuildShellTree();

        // タブバー末尾の「＋」ボタン（常に最後のタブの右隣）。
        _newTabButton = new Button
        {
            Content = "+",
            Width = 30, Height = 26, Padding = new Thickness(0),
            Margin = new Thickness(2, 3, 4, 0),
            FontSize = 16,
            Background = Brushes.Transparent,
            BorderThickness = new Thickness(0),
            Cursor = Cursors.Hand,
            ToolTip = "新しいタブ（空）",
        };
        _newTabButton.Click += NewTabButton_Click;
        TabStripPanel.Children.Add(_newTabButton);

        // 起動時のタブ復元：StartupMode=="last" かつ前回タブがあれば全タブを復元、なければ単一タブ。
        if (_settings.StartupMode == "last" && _settings.OpenTabs is { Count: > 0 })
        {
            // 2つ目以降をアクティブにしながら作るとタブが順々に切り替わってフラッシュするため、
            // 全タブを非アクティブ（Hidden）で初期化だけ行い、最後に対象タブだけをアクティブ化する。
            foreach (var f in _settings.OpenTabs)
            {
                var folder = (!string.IsNullOrEmpty(f) && Directory.Exists(f)) ? f : "";
                await CreateTabAsync(folder, activate: false);
            }
            var idx = Math.Clamp(_settings.ActiveTabIndex, 0, _tabs.Count - 1);
            ActivateTab(_tabs[idx]); // 対象だけ表示。他は Collapsed＋サスペンドへ。
        }
        else
        {
            await CreateTabAsync(ResolveStartupFolder() ?? "", activate: true);
        }
    }

    // ---- タブ管理（中央のファイル一覧。1タブ=1 WebView2・付け替えず Visibility で切替） ----
    private async Task<TabContext> CreateTabAsync(string initialFolder, bool activate)
    {
        // activate=false（起動時の復元など）はアクティブにせず初期化だけ行う。Collapsed だと
        // WebView2 が初期化されない（HWND 未生成）ため Hidden で初期化する（描画されない＝
        // 順々に作ってもフラッシュしない）。最後に ActivateTab(対象) で対象だけ表示される。
        var initialVis = activate ? Visibility.Collapsed : Visibility.Hidden;
        var view = new Microsoft.Web.WebView2.Wpf.WebView2 { Visibility = initialVis };
        var detailsView = new Microsoft.Web.WebView2.Wpf.WebView2 { Visibility = initialVis };
        TabContentHost.Children.Add(view);
        DetailsHost.Children.Add(detailsView);
        var tab = new TabContext { View = view, DetailsView = detailsView, InitialFolder = initialFolder ?? "" };
        if (!string.IsNullOrEmpty(initialFolder)) tab.CurrentFolder = initialFolder;
        BuildTabChip(tab);
        _tabs.Add(tab);
        // 「＋」ボタンの直前に挿入（＋を常に末尾＝最後のタブの右隣に保つ）。
        var insertAt = _newTabButton != null ? TabStripPanel.Children.IndexOf(_newTabButton) : TabStripPanel.Children.Count;
        if (insertAt < 0) insertAt = TabStripPanel.Children.Count;
        TabStripPanel.Children.Insert(insertAt, tab.Chip);

        if (activate) ActivateTab(tab); // 読み込み中も表示されるよう先にアクティブ化

        // 詳細を先にセットアップ（list がフォルダを読み込む＝folder_changed を出す前に詳細のIPCを用意）。
        tab.DetailsBridge = await SetupWebViewAsync(detailsView, "details.html", b => RegisterCommands(b, tab, isDetails: true));
        // list.html はロード時に get_initial_folder を呼び、tab.InitialFolder を開く。
        tab.Bridge = await SetupWebViewAsync(view, "list.html", b => RegisterCommands(b, tab));
        if (activate) FocusTab(tab);
        return tab;
    }

    private async Task NewTabFromActiveAsync()
    {
        var folder = _activeTab?.CurrentFolder ?? "";
        await CreateTabAsync(folder, activate: true); // Ctrl+T: 現タブと同じフォルダ
    }

    private async void NewTabButton_Click(object sender, RoutedEventArgs e)
        => await CreateTabAsync("", activate: true); // ＋ボタン: 空タブ

    private void ActivateTab(TabContext tab)
    {
        if (tab == null) return;
        _activeTab = tab;
        // 非アクティブタブは Collapsed にした上で CoreWebView2 を「サスペンド」する。
        // サスペンドするとレンダラー/コンポジションが解放され、ウィンドウリサイズ時の
        // 合成コストがタブ数に比例して増える問題が解消する。状態（DOM/スクロール/フィルタ）は
        // 保持され、アクティブ化時に Resume で復帰する（CoreWebView2 は別プロセス）。
        foreach (var t in _tabs)
        {
            var on = ReferenceEquals(t, tab);
            t.View.Visibility = on ? Visibility.Visible : Visibility.Collapsed;
            t.DetailsView.Visibility = on ? Visibility.Visible : Visibility.Collapsed;
            StyleChip(t, on);
            if (on) ResumeTab(t); else SuspendTab(t);
        }
        // ツリー選択だけアクティブタブに追従（詳細はタブ自身が状態を保持するので再取得・再送不要）。
        if (tab.Bridge != null && _settings.SyncTreeSelection && !string.IsNullOrEmpty(tab.CurrentFolder))
            _ = SelectInTree(tab.CurrentFolder);
        FocusTab(tab);
    }

    // 非アクティブタブの一覧・詳細をサスペンド（要：先に Visibility=Collapsed で IsVisible=false）。
    private async void SuspendTab(TabContext t)
    {
        if (t.Closed || t.Suspended) return;
        t.Suspended = true;
        try { if (t.View.CoreWebView2 != null) await t.View.CoreWebView2.TrySuspendAsync(); } catch { }
        try { if (t.DetailsView.CoreWebView2 != null) await t.DetailsView.CoreWebView2.TrySuspendAsync(); } catch { }
    }

    // アクティブ化したタブを復帰（サスペンド中だったときのみ）。
    private void ResumeTab(TabContext t)
    {
        if (t.Closed || !t.Suspended) return;
        t.Suspended = false;
        try { t.View.CoreWebView2?.Resume(); } catch { }
        try { t.DetailsView.CoreWebView2?.Resume(); } catch { }
    }

    private void FocusTab(TabContext tab)
    {
        // WebView にキーボードフォーカスを移す（ショートカットが効くように）＋ JS 側で
        // グリッドにフォーカスを移すよう通知（タブ間の貼り付け等が切替直後から効くように）。
        Dispatcher.BeginInvoke(new Action(() =>
        {
            if (tab.Closed) return;
            try { tab.View.Focus(); } catch { }
            tab.Bridge?.EmitEvent("focus_list", null);
        }), DispatcherPriority.Input);
    }

    private void SwitchTab(int delta)
    {
        if (_tabs.Count <= 1 || _activeTab == null) return;
        var idx = _tabs.IndexOf(_activeTab);
        var n = _tabs.Count;
        var next = ((idx + delta) % n + n) % n;
        ActivateTab(_tabs[next]);
    }

    private void CloseTab(TabContext? tab)
    {
        if (tab == null) return;
        if (_tabs.Count <= 1)
        {
            // 最後の1枚は閉じず、空タブにリセットする（タブが0個にならないように）。
            WatchFolder(tab, ""); // 監視停止
            tab.CurrentFolder = "";
            tab.Bridge?.EmitEvent("tab_make_empty", null);
            return;
        }
        var idx = _tabs.IndexOf(tab);
        if (idx < 0) return;

        tab.Closed = true; // 以後の遅延コールバック（監視tick/フォーカス/サスペンド）を無効化

        // タブ別モード：このタブの画像ウィンドウを閉じる。
        if (_tabImageHosts.TryGetValue(tab.Id, out var h)) h.Window.Close();

        tab.Watcher?.Dispose();
        tab.Watcher = null;
        if (tab.FsDebounce != null) { tab.FsDebounce.Stop(); tab.FsDebounce = null; }
        TabStripPanel.Children.Remove(tab.Chip);
        TabContentHost.Children.Remove(tab.View);
        DetailsHost.Children.Remove(tab.DetailsView);
        tab.Bridge = null;        // 破棄後の stray EmitEvent を no-op 化
        tab.DetailsBridge = null;
        try { tab.View.Dispose(); } catch { }
        try { tab.DetailsView.Dispose(); } catch { }
        _tabs.RemoveAt(idx);

        if (ReferenceEquals(_activeTab, tab))
            ActivateTab(_tabs[Math.Min(idx, _tabs.Count - 1)]);

        // 単一モード：閉じたタブが共有画像ウィンドウの所有者なら、現アクティブタブへ付け替える。
        if (_sharedImageHost != null && ReferenceEquals(_sharedImageHost.OwnerTab, tab) && _activeTab != null)
            _sharedImageHost.OwnerTab = _activeTab;
    }

    // ---- タブの見出し（WPF）。見た目だけ WPF、中身の WebView は TabContentHost に常駐 ----
    private void BuildTabChip(TabContext tab)
    {
        var title = new TextBlock
        {
            Text = tab.Title,
            VerticalAlignment = VerticalAlignment.Center,
            MaxWidth = 160,
            TextTrimming = TextTrimming.CharacterEllipsis,
            Margin = new Thickness(8, 0, 4, 0),
            Foreground = new SolidColorBrush(Color.FromRgb(0x2B, 0x2A, 0x27)),
        };
        var close = new Button
        {
            Content = "×", // ×
            Width = 18, Height = 18, Padding = new Thickness(0),
            FontSize = 12,
            Background = Brushes.Transparent, BorderThickness = new Thickness(0),
            Cursor = Cursors.Hand, Margin = new Thickness(0, 0, 4, 0),
            VerticalAlignment = VerticalAlignment.Center,
            ToolTip = "タブを閉じる",
        };
        close.Click += (_, _) => CloseTab(tab);

        var dock = new DockPanel { LastChildFill = true };
        DockPanel.SetDock(close, Dock.Right);
        dock.Children.Add(close);
        dock.Children.Add(title);

        var chip = new Border
        {
            Child = dock,
            Margin = new Thickness(2, 3, 0, 0),
            Padding = new Thickness(2),
            CornerRadius = new CornerRadius(6, 6, 0, 0),
            BorderThickness = new Thickness(1, 1, 1, 0),
            Cursor = Cursors.Hand,
            MinWidth = 90,
            ToolTip = tab.Title,
        };
        // 左ボタン：押下でドラッグ候補に。閾値を超えたらドラッグ並べ替え、超えなければクリック＝アクティブ化。
        chip.PreviewMouseLeftButtonDown += (_, e) =>
        {
            if (IsWithinButton(e.OriginalSource)) return; // ×ボタンはボタン側で処理
            _dragTab = tab;
            _dragStart = e.GetPosition(TabStripPanel);
            _dragMoved = false;
            _dropTarget = null;
            chip.CaptureMouse();
            e.Handled = true;
        };
        chip.PreviewMouseMove += (_, e) =>
        {
            if (!ReferenceEquals(_dragTab, tab) || e.LeftButton != MouseButtonState.Pressed) return;
            var pos = e.GetPosition(TabStripPanel);
            if (!_dragMoved)
            {
                if (Math.Abs(pos.X - _dragStart.X) < SystemParameters.MinimumHorizontalDragDistance &&
                    Math.Abs(pos.Y - _dragStart.Y) < SystemParameters.MinimumVerticalDragDistance) return;
                _dragMoved = true;
            }
            UpdateDragMarker(pos);
        };
        chip.PreviewMouseLeftButtonUp += (_, e) =>
        {
            if (!ReferenceEquals(_dragTab, tab)) return;
            // ReleaseMouseCapture は LostMouseCapture を同期発火させ _drag* を null に戻すため、
            // 必要な値を先に退避してから解放する（退避しないとドロップが毎回キャンセルされる）。
            var moved = _dragMoved;
            var dragged = _dragTab;
            var target = _dropTarget;
            var after = _dropAfter;
            if (chip.IsMouseCaptured) chip.ReleaseMouseCapture();
            _dragTab = null; _dragMoved = false; _dropTarget = null;
            ClearDragMarker();
            if (moved) MoveTab(dragged, target, after);
            else ActivateTab(tab); // 動いていなければ通常クリック＝アクティブ化
            e.Handled = true;
        };
        chip.LostMouseCapture += (_, _) =>
        {
            if (!ReferenceEquals(_dragTab, tab)) return;
            ClearDragMarker();
            _dragTab = null; _dragMoved = false; _dropTarget = null;
        };
        chip.MouseDown += (_, e) => { if (e.ChangedButton == MouseButton.Middle) { CloseTab(tab); e.Handled = true; } };

        tab.Chip = chip;
        tab.TitleText = title;
        StyleChip(tab, false);
    }

    private void StyleChip(TabContext tab, bool active)
    {
        tab.Chip.Background = new SolidColorBrush(active ? Color.FromRgb(0xFA, 0xF9, 0xF5) : Color.FromRgb(0xE8, 0xE5, 0xDB));
        tab.Chip.BorderBrush = new SolidColorBrush(Color.FromRgb(0xE0, 0xDC, 0xD0));
    }

    // クリック発生元が（×）ボタン内かどうか（ドラッグ開始の抑止に使う）。
    private static bool IsWithinButton(object? originalSource)
    {
        var d = originalSource as DependencyObject;
        while (d != null)
        {
            if (d is Button) return true;
            d = VisualTreeHelper.GetParent(d);
        }
        return false;
    }

    // ドラッグ中：カーソル位置（TabStripPanel 座標）から挿入先タブと前後を求め、マーカーを更新。
    private void UpdateDragMarker(Point pos)
    {
        TabContext? target = null;
        bool after = false;
        foreach (var t in _tabs)
        {
            var tl = t.Chip.TranslatePoint(new Point(0, 0), TabStripPanel);
            var r = new Rect(tl, t.Chip.RenderSize);
            if (r.Width <= 0 || pos.Y < r.Top || pos.Y > r.Bottom) continue; // 同じ段のみ
            if (pos.X < r.Left + r.Width / 2) { target = t; after = false; break; }
            target = t; after = true; // 段内の右側 → この段の最後尾に挿入（左半分が来れば break）
        }
        if (target == null && _tabs.Count > 0) { target = _tabs[^1]; after = true; } // 段外は末尾扱い

        // ドラッグ中タブ自身が対象で、結果的に位置が変わらないならマーカー非表示。
        if (target == null || ReferenceEquals(target, _dragTab))
        {
            _dropTarget = null;
            ClearDragMarker();
            return;
        }
        _dropTarget = target;
        _dropAfter = after;
        ShowDragMarker(target.Chip, after);
    }

    private void ShowDragMarker(Border chip, bool after)
    {
        if (ReferenceEquals(_dragAdornerChip, chip) && _dragAdornerAfter == after && _dragAdorner != null) return;
        ClearDragMarker();
        var layer = AdornerLayer.GetAdornerLayer(chip);
        if (layer == null) return;
        _dragAdorner = new TabInsertionAdorner(chip, after);
        layer.Add(_dragAdorner);
        _dragAdornerChip = chip;
        _dragAdornerAfter = after;
    }

    private void ClearDragMarker()
    {
        if (_dragAdorner != null && _dragAdornerChip != null)
            AdornerLayer.GetAdornerLayer(_dragAdornerChip)?.Remove(_dragAdorner);
        _dragAdorner = null;
        _dragAdornerChip = null;
    }

    // ドロップ確定：dragged を target の前/後へ移動（_tabs と TabStripPanel の両方を同期）。
    // 値は呼び出し側で退避済み（LostMouseCapture でフィールドがクリアされるため引数で受ける）。
    private void MoveTab(TabContext? dragged, TabContext? target, bool after)
    {
        if (dragged == null || target == null || ReferenceEquals(dragged, target)) return;
        var from = _tabs.IndexOf(dragged);
        var targetIdx = _tabs.IndexOf(target);
        if (from < 0 || targetIdx < 0) return;

        var insert = after ? targetIdx + 1 : targetIdx;
        if (insert > from) insert--;                 // 自分を抜いた分の補正
        insert = Math.Clamp(insert, 0, _tabs.Count - 1);
        if (insert == from) return;

        _tabs.RemoveAt(from);
        _tabs.Insert(insert, dragged);
        TabStripPanel.Children.Remove(dragged.Chip);
        TabStripPanel.Children.Insert(insert, dragged.Chip); // チップは先頭から並ぶので index 一致（＋は末尾）
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
    // tab != null のとき、その bridge はそのタブの一覧（isDetails=false）か詳細（isDetails=true）ペイン。
    private void RegisterCommands(IpcBridge bridge, TabContext? tab, bool isDetails = false)
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
        bridge.Register("set_trim_mode", args => { var m = Str(args, "mode"); if (!string.IsNullOrEmpty(m)) { _settings.TrimMode = m; SettingsService.Save(_settings); } return (object?)null; });
        bridge.Register("set_crop_penalty", args => { if (args.TryGetProperty("value", out var v) && v.TryGetDouble(out var d)) { _settings.CropPenalty = Math.Clamp(d, 0, 5); SettingsService.Save(_settings); } return (object?)null; });
        bridge.Register("open_shortcuts", _ => { OpenShortcutsWindow(); return (object?)null; });

        // 設定ウィンドウ（ツール → 設定）
        bridge.Register("get_settings", _ => SettingsPayload());
        bridge.Register("set_setting", args => { ApplySetting(args); return (object?)null; });
        bridge.Register("get_startup_folder", _ => (object?)ResolveStartupFolder()); // 互換用（未使用）
        bridge.Register("pick_folder", _ =>
        {
            var dlg = new Microsoft.Win32.OpenFolderDialog { Title = "起動時に開くフォルダを選択" };
            return dlg.ShowDialog(this) == true ? (object?)dlg.FolderName : null;
        });
        bridge.Register("get_file_info", args => (object?)ListingService.GetFileInfo(Str(args, "path")));
        // アドレスバー手入力の解決：フォルダー / 圧縮ファイル / 該当なし を判定して返す。
        bridge.Register("resolve_path", args =>
        {
            var p = (Str(args, "path") ?? "").Trim();
            if (string.IsNullOrEmpty(p)) return (object?)new { kind = "none" };
            try
            {
                if (Directory.Exists(p)) return (object?)new { kind = "folder", path = Path.GetFullPath(p) };
                if (File.Exists(p) && FileTypes.IsArchive(p)) return (object?)new { kind = "archive", path = Path.GetFullPath(p) };
            }
            catch { /* 不正な文字を含むパス等は none 扱い */ }
            return (object?)new { kind = "none" };
        });
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
        // 所有者は操作中のウィンドウ（画像ウィンドウからの削除でメインへフォーカスが移らないように）。
        bridge.Register("move_to_trash", args => (object?)ShellFileOperations.Recycle(StrArray(args, "paths"), ActiveOwnerHwnd()));
        // ペイン内 DnD：選択ファイルを宛先フォルダーへ移動（Ctrl ならコピー）。シェル委譲で
        // 競合解決・取り消し(Ctrl+Z)も Explorer と一致（仕様 §2.0/§2.2）。
        bridge.Register("drop_move_files", args =>
        {
            var paths = StrArray(args, "paths");
            var dest = Str(args, "destination");
            if (paths.Length == 0 || string.IsNullOrEmpty(dest) || !Directory.Exists(dest)) return (object?)null;
            if (Bool(args, "copy")) ShellFileOperations.Copy(paths, dest, ActiveOwnerHwnd(), renameOnCollision: false);
            else ShellFileOperations.Move(paths, dest, ActiveOwnerHwnd());
            return (object?)null;
        });
        bridge.Register("rename_file", args =>
        {
            var oldPath = Str(args, "oldPath");
            var newName = Str(args, "newName");
            FileOpsService.ValidateNewName(newName); // 不正名は例外→フロントでトースト
            ShellFileOperations.Rename(oldPath, newName, ActiveOwnerHwnd()); // シェル委譲（取り消し可・仕様 §2.0）
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
                foreach (var t in _tabs) { t.Bridge?.EmitEvent("shortcuts-updated", null); t.DetailsBridge?.EmitEvent("shortcuts-updated", null); }
                foreach (var h in AllImageHosts()) h.Bridge?.EmitEvent("shortcuts-updated", null);
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

        // 詳細ペイン（タブごと）専用コマンド：このタブの一覧・フォルダへ直結する。
        if (tab != null && isDetails)
        {
            // 詳細ペインが算出した可視パス集合を「同じタブ」の一覧へ中継（タブ内直結）。
            bridge.Register("apply_tag_filter", args =>
            {
                tab.Bridge?.EmitEvent("tag_filter", new { active = Bool(args, "active"), paths = StrArray(args, "paths") });
                return (object?)null;
            });
            // タグ抽出は「このタブのフォルダ」を対象にする（仕様 §7）。
            bridge.Register("get_all_image_prompts", async _ =>
            {
                var folder = tab.WatchedFolder;
                return await Task.Run<object?>(() => GetAllImagePrompts(folder));
            });
        }

        // 一覧ペイン（タブごと）専用コマンド。
        if (tab != null && !isDetails)
        {
            // 一覧→「同じタブ」の詳細ペインへ選択を中継（タブ内直結。アクティブ判定は不要）。
            bridge.Register("selection_changed", args =>
            {
                var paths = StrArray(args, "paths");
                var archivePath = Str(args, "archivePath");
                tab.DetailsBridge?.EmitEvent("show_details", new { paths, archive_path = archivePath });
                return (object?)null;
            });

            // フォルダーを開いた（ダブルクリック等）。タブのフォルダ状態を更新。
            bridge.Register("host_navigated", args =>
            {
                var p = Str(args, "path");
                if (!string.IsNullOrEmpty(p)) tab.CurrentFolder = p;
                return (object?)null;
            });

            // タブが最初に開くべきフォルダ（生成時に host が設定）。空なら空タブ。
            bridge.Register("get_initial_folder", _ => (object?)tab.InitialFolder);

            // タブの見出しを更新（フォルダ名・書庫名など。一覧側が算出して通知）。
            bridge.Register("set_tab_title", args =>
            {
                var title = Str(args, "title");
                tab.Title = string.IsNullOrEmpty(title) ? "新しいタブ" : title;
                tab.TitleText.Text = tab.Title;
                tab.Chip.ToolTip = tab.Title;
                return (object?)null;
            });

            // 表示中フォルダーの監視対象を更新（仕様 §1.5）。書庫内は path 空で停止。
            bridge.Register("watch_folder", args => { WatchFolder(tab, Str(args, "path")); return (object?)null; });

            // 画像を開く（イメージウィンドウ。単一/タブ別は設定で切替）。
            bridge.Register("open_image", async args =>
            {
                await OpenImage(tab, Str(args, "path"), Str(args, "archivePath"), Str(args, "innerPath"), StrArray(args, "paths"));
                return (object?)null;
            });

            // タグフィルター変更時に、このタブに紐づく画像ウィンドウの画像リストも更新（仕様 §4.5/§7）。
            bridge.Register("update_viewer_images", args =>
            {
                var host = ImageHostForTab(tab);
                host?.Bridge?.EmitEvent("filter_images_changed", new { paths = StrArray(args, "paths") });
                return (object?)null;
            });

            // タブ操作（一覧側ショートカットから・既定 Ctrl+T / Ctrl+F4 / Ctrl+Tab）。
            bridge.Register("new_tab", args => { _ = NewTabFromActiveAsync(); return (object?)null; });
            bridge.Register("new_tab_with_folder", args =>
            {
                var p = Str(args, "path");
                if (!string.IsNullOrEmpty(p) && Directory.Exists(p)) _ = CreateTabAsync(p, activate: true);
                return (object?)null;
            });
            bridge.Register("close_tab", _ => { CloseTab(tab); return (object?)null; });
            bridge.Register("switch_tab", args =>
            {
                var d = args.TryGetProperty("delta", out var v) && v.TryGetInt32(out var n) ? n : 1;
                SwitchTab(d);
                return (object?)null;
            });
        }
    }

    // ---- イメージウィンドウ（仕様 §4。単一モード＝全タブ共有1個 / タブ別モード＝タブごと1個） ----
    // <paramref name="visiblePaths"/> は一覧ペインが渡す「現在表示中の画像パス（タグフィルター
    // 適用後・ソート順）」。ビューワの切替/先読みがこの集合だけを巡るよう、これを画像リストの
    // 単一の真実源にする（仕様 §4.5/§7）。空のときのみフォルダー/書庫を直接列挙してフォールバック。
    private async Task OpenImage(TabContext tab, string path, string archivePath, string innerPath, string[] visiblePaths)
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

        var payload = new
        {
            images,
            index,
            // 新規に開く枚数：「決まった枚数」なら固定値、そうでなければ前回の枚数(ViewCount)。
            view_count = _settings.ImageCountMode == "fixed" ? _settings.ImageCountFixed : _settings.ViewCount,
            reading_rtl = _settings.ReadingRtl,
            trim_mode = _settings.TrimMode,
            crop_penalty = _settings.CropPenalty,
            layout = _settings.LayoutMode,
            end_marker = _settings.EndMarker,
            loop = _settings.LoopNavigation,
            preload = _settings.PreloadCount,
        };

        // このタブが使う画像ウィンドウを取得（無ければ生成）。単一モードでは共有ウィンドウの
        // 所有タブを今のタブに付け替える（＝逆方向の選択同期が正しい一覧へ向くように）。
        var host = ImageHostForTab(tab);
        if (host == null)
        {
            host = await CreateImageHostAsync(tab, payload);
        }
        else
        {
            host.OwnerTab = tab;
            host.PendingPayload = payload;
            if (host.Window.WindowState == WindowState.Minimized) host.Window.WindowState = WindowState.Normal;
            host.Window.Activate();
            host.Window.View.Focus();
            host.Bridge?.EmitEvent("load_images", payload);
        }
    }

    /// <summary>このタブに紐づく画像ウィンドウ（無ければ null）。単一モードは共有、タブ別は辞書。</summary>
    private ImageHost? ImageHostForTab(TabContext tab)
        => _settings.ImageWindowPerTab ? _tabImageHosts.GetValueOrDefault(tab.Id) : _sharedImageHost;

    /// <summary>開いている全画像ウィンドウ（ブロードキャスト用）。</summary>
    private IEnumerable<ImageHost> AllImageHosts()
    {
        if (_sharedImageHost != null) yield return _sharedImageHost;
        foreach (var h in _tabImageHosts.Values) yield return h;
    }

    private async Task<ImageHost> CreateImageHostAsync(TabContext tab, object payload)
    {
        var win = new ImageWindow { Owner = _settings.ImageWindowAlwaysOnTop ? this : null };
        var host = new ImageHost { Window = win, OwnerTab = tab, PendingPayload = payload };

        // 単一/タブ別で保管先を分ける。
        if (_settings.ImageWindowPerTab) _tabImageHosts[tab.Id] = host;
        else _sharedImageHost = host;

        // 保存済みのサイズ/位置を復元（仕様 §4 / §9）。
        win.Width = _settings.ImageWindowWidth;
        win.Height = _settings.ImageWindowHeight;
        if (_settings.ImageWindowLeft is double il && _settings.ImageWindowTop is double it)
        {
            win.WindowStartupLocation = WindowStartupLocation.Manual;
            win.Left = il;
            win.Top = it;
        }
        if (_settings.ImageWindowMaximized) win.WindowState = WindowState.Maximized;

        win.Closing += (s, _) => SaveImageWindowBounds((ImageWindow)s!);
        win.Closed += (_, _) =>
        {
            if (ReferenceEquals(_sharedImageHost, host)) _sharedImageHost = null;
            var key = _tabImageHosts.FirstOrDefault(kv => ReferenceEquals(kv.Value, host)).Key;
            if (key != null) _tabImageHosts.Remove(key);
        };
        win.Show();

        host.Bridge = await SetupWebViewAsync(win.View, "viewer.html", b =>
        {
            RegisterCommands(b, null);
            RegisterViewerCommands(b, host);
        });

        // 表示直後は WebView2 にキーボードフォーカスが無いので、読み込み完了時に移す。
        var view = win.View;
        void FocusWhenLoaded(object? s, CoreWebView2NavigationCompletedEventArgs e)
        {
            view.CoreWebView2.NavigationCompleted -= FocusWhenLoaded;
            Dispatcher.BeginInvoke(() => { win.Activate(); view.Focus(); });
        }
        view.CoreWebView2.NavigationCompleted += FocusWhenLoaded;
        return host;
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

    // 画像ウィンドウ専用コマンド。host を捕捉して、その画像ウィンドウ／所有タブへ正しく届ける。
    private void RegisterViewerCommands(IpcBridge bridge, ImageHost host)
    {
        // viewer ページが起動完了時に呼ぶ。初期の画像リスト＋インデックスを返す。
        bridge.Register("viewer_ready", _ => host.PendingPayload);

        // 画像のファイル情報（詳細オーバーレイ用。メタデータ本実装は §6 で後続）。
        bridge.Register("get_file_info", args => (object?)ListingService.GetFileInfo(Str(args, "path")));

        // ビューワが表示中画像を通知 → 設定ONなら「所有タブ」の一覧でその画像を選択（書庫内は inner path）。
        bridge.Register("viewer_current_image", args =>
        {
            if (_settings.SyncListSelection)
            {
                var ap = Str(args, "archivePath");
                var sel = string.IsNullOrEmpty(ap) ? Str(args, "path") : Str(args, "innerPath");
                if (!string.IsNullOrEmpty(sel)) host.OwnerTab.Bridge?.EmitEvent("select_image", new { path = sel });
            }
            return (object?)null;
        });

        // フルスクリーン切替（ホスト側で window を制御。仕様 §4.3）。
        bridge.Register("toggle_fullscreen", args =>
        {
            var on = Bool(args, "fullscreen");
            host.Window.SetFullscreen(on);
            // ウィンドウサイズ確定後にビューワへ再レイアウトを通知（画像をフィットし直す）。
            Dispatcher.BeginInvoke(new Action(() => host.Bridge?.EmitEvent("relayout", null)),
                System.Windows.Threading.DispatcherPriority.Background);
            return (object?)null;
        });

        // ウィンドウを閉じる（仕様 §4.3）。
        bridge.Register("close_viewer", _ =>
        {
            host.Window.Close();
            return (object?)null;
        });

        // タイトル更新（現在画像のパス等）。
        bridge.Register("set_viewer_title", args =>
        {
            host.Window.Title = Str(args, "title");
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
        var dragSrc = (DependencyObject?)_activeTab?.View ?? TabContentHost;
        var effect = DragDrop.DoDragDrop(dragSrc, data, allowed);

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

    // Ctrl+左クリック（既定）でツリーのフォルダを新しいタブで開く。割当はショートカット設定
    // （カタログ tree.open_new_tab）から解決するので、設定で変更すればここも従う。
    private void FolderTree_PreviewMouseDown(object sender, MouseButtonEventArgs e)
    {
        var want = ResolveMouseBinding("tree.open_new_tab", "Ctrl+左クリック");
        if (string.IsNullOrEmpty(want) || MouseStringFromButton(e.ChangedButton) != want) return;

        var tvi = FindAncestorTreeViewItem(e.OriginalSource as DependencyObject);
        if (tvi?.Tag is not ShellNode node) return;
        var path = node.FileSystemPath;
        if (node.IsArchive || string.IsNullOrEmpty(path) || !Directory.Exists(path)) return;

        e.Handled = true; // 通常の選択／アクティブタブのナビゲートを抑止
        _ = CreateTabAsync(path, activate: true);
    }

    // ツリーで右クリック → コンテキストメニュー（「新しいタブで開く」）。フォルダのみ有効。
    private void FolderTree_PreviewMouseRightButtonDown(object sender, MouseButtonEventArgs e)
    {
        var tvi = FindAncestorTreeViewItem(e.OriginalSource as DependencyObject);
        if (tvi?.Tag is not ShellNode node) return; // ノード外なら何もしない

        var path = node.FileSystemPath;
        var isFolder = !node.IsArchive && !string.IsNullOrEmpty(path) && Directory.Exists(path);

        var menu = new ContextMenu { PlacementTarget = tvi };
        var open = new MenuItem { Header = "新しいタブで開く", IsEnabled = isFolder };
        open.Click += (_, _) => { if (isFolder) _ = CreateTabAsync(path!, activate: true); };
        menu.Items.Add(open);
        menu.IsOpen = true;
        e.Handled = true; // 既定の選択／メニューを抑止
    }

    // クリック種別＋修飾キーを、カタログのマウス表記（"Ctrl+左クリック" 等）に変換する。
    private static string MouseStringFromButton(MouseButton button)
    {
        var b = button switch
        {
            MouseButton.Left => "左クリック",
            MouseButton.Middle => "中クリック",
            MouseButton.Right => "右クリック",
            _ => "",
        };
        if (b == "") return "";
        var mods = Keyboard.Modifiers;
        var prefix = "";
        if (mods.HasFlag(ModifierKeys.Control)) prefix += "Ctrl+";
        if (mods.HasFlag(ModifierKeys.Alt)) prefix += "Alt+";
        if (mods.HasFlag(ModifierKeys.Shift)) prefix += "Shift+";
        return prefix + b;
    }

    // shortcuts.json から指定アクションのマウス割当を解決（未設定なら既定）。
    private static string ResolveMouseBinding(string id, string defaultMouse)
    {
        try
        {
            if (ShortcutsService.Load() is JsonElement root && root.ValueKind == JsonValueKind.Object
                && root.TryGetProperty("bindings", out var arr) && arr.ValueKind == JsonValueKind.Array)
            {
                foreach (var b in arr.EnumerateArray())
                {
                    if (b.TryGetProperty("id", out var bid) && bid.GetString() == id)
                        return b.TryGetProperty("mouse", out var m) && m.ValueKind == JsonValueKind.String
                            ? (m.GetString() ?? defaultMouse) : defaultMouse;
                }
            }
        }
        catch { /* 壊れた設定は既定で続行 */ }
        return defaultMouse;
    }

    private static TreeViewItem? FindAncestorTreeViewItem(DependencyObject? src)
    {
        while (src != null && src is not TreeViewItem) src = VisualTreeHelper.GetParent(src);
        return src as TreeViewItem;
    }

    private async void FolderTree_SelectedItemChanged(object sender, RoutedPropertyChangedEventArgs<object> e)
    {
        if (_suppressTreeNavigate) return; // プログラムからの選択（一覧→ツリー同期）では一覧を動かさない
        if (e.NewValue is not TreeViewItem item || item.Tag is not ShellNode node) return;

        // 圧縮ファイルは一覧で「書庫展開」する（フォルダー遷移ではない）。
        if (node.IsArchive && !string.IsNullOrEmpty(node.FileSystemPath))
        {
            _activeTab?.Bridge?.EmitEvent("navigate_archive", new { path = node.FileSystemPath });
            return;
        }

        // 実フォルダー（ファイルシステムパスあり）はそのフォルダーへナビゲート。
        var path = node.FileSystemPath;
        if (!string.IsNullOrEmpty(path) && Directory.Exists(path))
        {
            _activeTab?.Bridge?.EmitEvent("navigate", new { path });
            return;
        }

        // 仮想フォルダー（PC/ホーム/ギャラリー/ネットワーク等）はパスが無い。Explorer で
        // 「PC」を開くとドライブ一覧が出るのと同様、子のうち実フォルダーを一覧に表示する。
        // 列挙はバックグラウンド。待機中は一覧にローディングを表示。
        _activeTab?.Bridge?.EmitEvent("list_loading", new { });
        try
        {
            var children = await node.GetChildrenAsync();
            var folders = children
                .Where(c => !string.IsNullOrEmpty(c.FileSystemPath) && Directory.Exists(c.FileSystemPath))
                .Select(c => (object)new { path = c.FileSystemPath, name = c.DisplayName })
                .ToList();
            _activeTab?.Bridge?.EmitEvent("show_folders", new { title = node.DisplayName, folders });
        }
        catch
        {
            _activeTab?.Bridge?.EmitEvent("show_folders", new { title = node.DisplayName, folders = Array.Empty<object>() });
        }
    }

    /// <summary>メインウィンドウのハンドル（シェル操作のダイアログ親に使う）。</summary>
    private IntPtr Hwnd => new System.Windows.Interop.WindowInteropHelper(this).Handle;

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    /// <summary>シェル操作（IFileOperation）の所有者に渡すウィンドウ。
    /// IFileOperation は所有者ウィンドウをアクティブ化するため、メインウィンドウ固定だと
    /// 画像ウィンドウからの削除等でメインウィンドウへフォーカスが奪われてしまう。
    /// いまのフォアグラウンドが自プロセスのウィンドウ（＝操作中の画像ウィンドウ等）なら
    /// それを所有者にして、操作後もそのウィンドウがアクティブなままになるようにする。</summary>
    private IntPtr ActiveOwnerHwnd()
    {
        var fg = GetForegroundWindow();
        if (fg != IntPtr.Zero)
        {
            GetWindowThreadProcessId(fg, out var pid);
            if (pid == (uint)Environment.ProcessId) return fg;
        }
        return Hwnd;
    }

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

    // ---- フォルダー監視（仕様 §1.5・タブごと） ----
    private void WatchFolder(TabContext tab, string path)
    {
        // 同じフォルダーなら何もしない。
        if (string.Equals(path, tab.WatchedFolder, StringComparison.OrdinalIgnoreCase)) return;

        tab.Watcher?.Dispose();
        tab.Watcher = null;
        tab.WatchedFolder = "";

        if (string.IsNullOrEmpty(path) || !Directory.Exists(path))
        {
            // 書庫内など監視対象が無い場合でも、このタブの詳細ペインへ通知（タグ再構築）。
            tab.DetailsBridge?.EmitEvent("folder_changed", new { path = "" });
            return;
        }
        tab.CurrentFolder = path; // ディスク上の現在フォルダ（Ctrl+T 複製・ツリー同期の基準）
        if (ReferenceEquals(tab, _activeTab) && _settings.SyncTreeSelection) _ = SelectInTree(path);

        try
        {
            var w = new FileSystemWatcher(path)
            {
                IncludeSubdirectories = false,
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName
                             | NotifyFilters.LastWrite | NotifyFilters.Size,
            };
            void Handler(object s, FileSystemEventArgs e) => OnFsEvent(tab);
            w.Created += Handler;
            w.Deleted += Handler;
            w.Renamed += (s, e) => OnFsEvent(tab);
            w.Changed += Handler;
            w.EnableRaisingEvents = true;
            tab.Watcher = w;
            tab.WatchedFolder = path;
        }
        catch { /* アクセス不可等は監視なしで継続 */ }

        // このタブの詳細ペインへフォルダー変更を通知（タグ再構築・フィルタ初期化・仕様 §7）。
        tab.DetailsBridge?.EmitEvent("folder_changed", new { path = tab.WatchedFolder });
    }

    // FileSystemWatcher のイベントはスレッドプールで発火。UI スレッドでタブごとにデバウンスして通知。
    private void OnFsEvent(TabContext tab)
    {
        Dispatcher.BeginInvoke(() =>
        {
            if (tab.Closed) return; // 閉じたタブの遅延イベントは無視
            // タブ専用タイマーを初回だけ生成（Tick はこのタブを捕捉して一度だけ束ねる）。
            if (tab.FsDebounce == null)
            {
                tab.FsDebounce = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(300) };
                tab.FsDebounce.Tick += (_, _) =>
                {
                    tab.FsDebounce?.Stop();
                    if (tab.Closed) return;
                    tab.Bridge?.EmitEvent("fs_changed", new { path = tab.WatchedFolder });
                };
            }
            tab.FsDebounce.Stop();
            tab.FsDebounce.Start();
        });
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
            n = ShellFileOperations.Move(files, destination, ActiveOwnerHwnd());
            System.Windows.Clipboard.Clear(); // 移動済みのソースを参照し続けないように
        }
        else
        {
            // 同一フォルダーへのコピーは自動リネーム（「- コピー」）。別フォルダーは衝突時に
            // Explorer 標準の置換/スキップ ダイアログ（=自動リネームしない）。
            n = ShellFileOperations.Copy(files, destination, ActiveOwnerHwnd(), renameOnCollision: allSameDir);
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
