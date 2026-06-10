using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using Microsoft.Web.WebView2.Core;
using Viewer.Backend;
using Viewer.Ipc;

namespace Viewer;

public partial class MainWindow : Window
{
    private const string AppHost = "https://app.viewer";
    private const string FileHost = "file.viewer"; // 画像配信用の仮想ホスト
    private const string Dummy = "__dummy__";

    private IpcBridge? _listBridge;
    private IpcBridge? _detailsBridge;
    private string _webAssetsPath = "";

    public MainWindow()
    {
        InitializeComponent();
        Loaded += OnLoaded;
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        _webAssetsPath = Path.Combine(AppContext.BaseDirectory, "WebAssets");

        // ポータブル設計：WebView2 のユーザーデータも exe 隣に置く（仕様 §9）。
        var userData = Path.Combine(AppContext.BaseDirectory, "WebView2Data");
        var env = await CoreWebView2Environment.CreateAsync(null, userData);

        await InitWebViewAsync(ListView, env, "list.html", isList: true);
        await InitWebViewAsync(DetailsView, env, "details.html", isList: false);

        BuildDriveTree();
    }

    private async Task InitWebViewAsync(
        Microsoft.Web.WebView2.Wpf.WebView2 view,
        CoreWebView2Environment env,
        string page,
        bool isList)
    {
        await view.EnsureCoreWebView2Async(env);
        var core = view.CoreWebView2;

        // Tauri 互換シムをドキュメント生成時に注入（既存フロント流用）。
        await core.AddScriptToExecuteOnDocumentCreatedAsync(IpcBridge.BootstrapScript);

        // WebAssets を仮想ホストで配信。
        core.SetVirtualHostNameToFolderMapping(
            "app.viewer", _webAssetsPath, CoreWebView2HostResourceAccessKind.Allow);

        // 画像をディスクから直接配信（仕様 §3：キャッシュなし・WebView2 がデコード）。
        core.AddWebResourceRequestedFilter($"https://{FileHost}/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += (s, args) => OnFileResourceRequested(env, args);

        var bridge = new IpcBridge(core, Dispatcher);
        RegisterCommands(bridge, isList);
        if (isList) _listBridge = bridge; else _detailsBridge = bridge;

        core.Settings.AreDevToolsEnabled = true;

        core.Navigate($"{AppHost}/{page}");
    }

    // ---- 画像配信（https://file.viewer/raw?p=<urlencoded full path>） ----
    private void OnFileResourceRequested(CoreWebView2Environment env, CoreWebView2WebResourceRequestedEventArgs args)
    {
        try
        {
            var uri = new Uri(args.Request.Uri);
            var path = QueryParam(uri.Query, "p");
            if (string.IsNullOrEmpty(path) || !File.Exists(path))
            {
                args.Response = env.CreateWebResourceResponse(null, 404, "Not Found", "");
                return;
            }

            // TIFF は Chromium 非対応のため将来 PNG 変換が必要（仕様 §3）。今は素通し。
            var stream = File.OpenRead(path);
            var mime = MimeOf(path);
            args.Response = env.CreateWebResourceResponse(
                stream, 200, "OK", $"Content-Type: {mime}\r\nCache-Control: no-store");
        }
        catch
        {
            args.Response = env.CreateWebResourceResponse(null, 500, "Error", "");
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
        bridge.Register("get_files", args => (object?)ListingService.GetFiles(Str(args, "path")));
        bridge.Register("get_file_info", args => (object?)ListingService.GetFileInfo(Str(args, "path")));
        bridge.Register("get_drives", _ => (object?)ListingService.GetDrives());
        bridge.Register("get_folder_tree", args => (object?)ListingService.GetFolderTree(Str(args, "path")));

        // ファイル操作
        bridge.Register("move_to_trash", args => (object?)FileOpsService.MoveToTrash(StrArray(args, "paths")));
        bridge.Register("rename_file", args => (object?)FileOpsService.RenameFile(Str(args, "oldPath"), Str(args, "newName")));

        // ショートカット（流用フロントが load_shortcuts を呼ぶ）。当面は既定（上書きなし）。
        bridge.Register("load_shortcuts", _ => (object?)new ShortcutSettings());

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
            bridge.Register("selection_changed", args =>
            {
                var paths = StrArray(args, "paths");
                _detailsBridge?.EmitEvent("show_details", new { paths });
                return (object?)null;
            });

            // フォルダーを開いた（ダブルクリック等）→ ツリー選択の追従（将来）。
            bridge.Register("host_navigated", _ => (object?)null);

            // 画像を開く（イメージウィンドウ）→ 当面は未実装スタブ（仕様 §4：1ウィンドウ）。
            bridge.Register("open_image", _ => (object?)null);
        }
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

    // ---- フォルダーツリー（当面はファイルシステム） ----
    private void BuildDriveTree()
    {
        FolderTree.Items.Clear();
        foreach (var d in ListingService.GetDrives())
            FolderTree.Items.Add(CreateNode(d.Name, d.Path));
    }

    private static TreeViewItem CreateNode(string header, string path)
    {
        var node = new TreeViewItem { Header = header, Tag = path };
        node.Items.Add(Dummy); // 遅延展開用ダミー
        return node;
    }

    private void FolderTree_Expanded(object sender, RoutedEventArgs e)
    {
        if (e.OriginalSource is not TreeViewItem node) return;
        if (node.Items.Count != 1 || node.Items[0] as string != Dummy) return; // 展開済みは無視

        node.Items.Clear();
        if (node.Tag is not string path || string.IsNullOrEmpty(path)) return;

        foreach (var f in ListingService.GetFolderTree(path))
        {
            var child = new TreeViewItem { Header = f.Name, Tag = f.Path };
            if (f.HasChildren) child.Items.Add(Dummy);
            node.Items.Add(child);
        }
    }

    private void FolderTree_SelectedItemChanged(object sender, RoutedPropertyChangedEventArgs<object> e)
    {
        if (e.NewValue is not TreeViewItem node) return;
        if (node.Tag is not string path || string.IsNullOrEmpty(path)) return;

        // 一覧ペインへ「カレントフォルダー変更」を配信（仕様 §1.2）。
        _listBridge?.EmitEvent("navigate", new { path });
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
