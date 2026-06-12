using System.Runtime.InteropServices;

namespace Viewer.Shell;

/// <summary>
/// シェル名前空間のノード。表示名・ファイルシステムパス・解析パス（再生成用）・子の有無・
/// アイコン（生成時に取得して凍結済み）を保持する。COM オブジェクト（IShellItem）は保持せず、
/// 子の列挙は <see cref="ParsingName"/> から別スレッドで作り直して行う（UI を固めないため）。
/// </summary>
public sealed class ShellNode
{
    public string DisplayName { get; }
    /// <summary>ファイルシステム上のパス（"C:\" 等）。仮想フォルダー（PC/ネットワーク等）では null。</summary>
    public string? FileSystemPath { get; }
    /// <summary>絶対解析名（別スレッドで IShellItem を作り直すのに使う）。</summary>
    public string? ParsingName { get; }
    public bool HasChildren { get; }
    /// <summary>シェルアイコン（生成時に取得・凍結済み。UI スレッドからそのまま使える）。</summary>
    public System.Windows.Media.ImageSource? Icon { get; }

    internal ShellNode(string displayName, string? fsPath, string? parsingName, bool hasChildren,
                       System.Windows.Media.ImageSource? icon)
    {
        DisplayName = displayName;
        FileSystemPath = fsPath;
        ParsingName = parsingName;
        HasChildren = hasChildren;
        Icon = icon;
    }

    /// <summary>子フォルダーをバックグラウンドで列挙する（ネットワーク等でも UI を固めない）。</summary>
    public Task<IReadOnlyList<ShellNode>> GetChildrenAsync() => ShellTree.EnumerateChildrenAsync(ParsingName);

    public System.Windows.Media.ImageSource? GetIcon() => Icon;
}

/// <summary>
/// シェル名前空間ツリーの構築（仕様 §1.2 / C.6）。
/// デスクトップ直下を起点に、Explorer のナビゲーションペイン相当
/// （PC・ライブラリ・ネットワーク等）を列挙する。STA（WPF UI スレッド）で呼ぶこと。
/// </summary>
public static class ShellTree
{
    /// <summary>
    /// ツリーのトップレベル。Windows 11 エクスプローラーのナビゲーションペインと同じ並び
    /// （ホーム→ギャラリー→OneDrive→デスクトップ→ダウンロード→ドキュメント→ピクチャ→
    /// ミュージック→ビデオ→PC→ネットワーク）を明示的に構築する。存在しない項目は飛ばす。
    /// </summary>
    public static IReadOnlyList<ShellNode> GetRoots()
    {
        var parsing = new List<string?>
        {
            "shell:::{679f85cb-0220-4080-b29b-5540cc05aab6}", // ホーム（クイックアクセス）
            "shell:::{e88865ea-0e1c-4e20-9aa6-edcd0212c87c}", // ギャラリー
            "shell:OneDrive",                                   // OneDrive（未導入なら null 扱い）
            PathOf(Environment.SpecialFolder.DesktopDirectory), // デスクトップ（実フォルダー）
            "shell:Downloads",                                  // ダウンロード
            PathOf(Environment.SpecialFolder.MyDocuments),      // ドキュメント
            PathOf(Environment.SpecialFolder.MyPictures),       // ピクチャ
            PathOf(Environment.SpecialFolder.MyMusic),          // ミュージック
            PathOf(Environment.SpecialFolder.MyVideos),         // ビデオ
            "shell:MyComputerFolder",                           // PC（This PC）
            "shell:NetworkPlacesFolder",                        // ネットワーク
        };

        var roots = new List<ShellNode>();
        foreach (var name in parsing)
        {
            if (string.IsNullOrEmpty(name)) continue;
            var item = CreateItem(name);
            if (item == null) continue;
            var node = MakeNode(item, requireFolder: false); // ルートはコンテナ前提（FOLDER 判定不要）
            if (node == null) continue;
            // フレンドリ名が解決できず "::{GUID}" / "{GUID}" の生 CLSID 表記になる項目
            // （例: 未設定の OneDrive）はツリーに出さない。
            if (LooksLikeRawClsid(node.DisplayName)) continue;
            roots.Add(node);
        }
        return roots;
    }

    private static bool LooksLikeRawClsid(string name)
    {
        if (string.IsNullOrEmpty(name)) return false;
        if (name.StartsWith("::", StringComparison.Ordinal)) return true;
        return name.StartsWith("{", StringComparison.Ordinal) && name.EndsWith("}", StringComparison.Ordinal);
    }

    private static string? PathOf(Environment.SpecialFolder f)
    {
        var p = Environment.GetFolderPath(f);
        return string.IsNullOrEmpty(p) ? null : p;
    }

    /// <summary>解析名から IShellItem を作り直し、その子フォルダーを列挙する（別スレッド実行）。
    /// COM はアパートメント依存のため、UI スレッドの IShellItem を別スレッドから呼ぶと結局
    /// UI スレッドで実行されて固まる。よって生成からこのスレッドで行う。</summary>
    internal static Task<IReadOnlyList<ShellNode>> EnumerateChildrenAsync(string? parsingName)
    {
        if (string.IsNullOrEmpty(parsingName))
            return Task.FromResult<IReadOnlyList<ShellNode>>(Array.Empty<ShellNode>());
        return Task.Run<IReadOnlyList<ShellNode>>(() =>
        {
            var item = CreateItem(parsingName);
            return item == null ? Array.Empty<ShellNode>() : EnumerateFolders(item);
        });
    }

    internal static IReadOnlyList<ShellNode> EnumerateFolders(IShellItem parent)
    {
        var result = new List<ShellNode>();
        IEnumShellItems? en = null;
        try
        {
            var bhid = ShellInterop.BHID_EnumItems;
            var iid = ShellInterop.IID_IEnumShellItems;
            parent.BindToHandler(IntPtr.Zero, ref bhid, ref iid, out var pEnum);
            if (pEnum == IntPtr.Zero) return result;
            en = (IEnumShellItems)Marshal.GetObjectForIUnknown(pEnum);
            Marshal.Release(pEnum);

            while (en.Next(1, out var item, out var fetched) == 0 && fetched == 1)
            {
                var node = MakeNode(item, requireFolder: true);
                if (node != null) result.Add(node);
            }
        }
        catch
        {
            // 列挙不能なノード（アクセス不可のネットワーク等）は空で返す
        }
        finally
        {
            if (en != null) Marshal.ReleaseComObject(en);
        }
        return result;
    }

    private static ShellNode? MakeNode(IShellItem item, bool requireFolder)
    {
        try
        {
            if (requireFolder)
            {
                item.GetAttributes((uint)ShellInterop.SFGAO.FOLDER, out var attr);
                if ((attr & (uint)ShellInterop.SFGAO.FOLDER) == 0) return null; // フォルダーのみ
            }

            // 隠しフォルダーは設定「隠しファイルを表示」がOFFなら除外（一覧の ShouldSkip と一致）。
            if (!Viewer.Backend.ListingService.ShowHidden)
            {
                item.GetAttributes((uint)ShellInterop.SFGAO.HIDDEN, out var hattr);
                if ((hattr & (uint)ShellInterop.SFGAO.HIDDEN) != 0) return null;
            }

            var name = GetName(item, ShellInterop.SIGDN.NORMALDISPLAY) ?? "";
            var fsPath = GetName(item, ShellInterop.SIGDN.FILESYSPATH); // 仮想なら null
            var parsing = GetName(item, ShellInterop.SIGDN.DESKTOPABSOLUTEPARSING); // 再生成用
            var icon = ShellIcon.Get(item); // この時点（列挙スレッド）で取得＆凍結

            // SFGAO_HASSUBFOLDER は「ネットワーク」等でネットワーク探索を伴い UI を
            // 数秒～無期限ブロックすることがある。フォルダーは一律「展開可能」と仮定し、
            // 実際の子は展開時に遅延列挙する（空なら展開時に葉になる）。仕様 §1.2。
            return new ShellNode(name, fsPath, parsing, hasChildren: true, icon);
        }
        catch
        {
            return null;
        }
    }

    private static string? GetName(IShellItem item, ShellInterop.SIGDN kind)
    {
        IntPtr p = IntPtr.Zero;
        try
        {
            item.GetDisplayName(kind, out p);
            return p == IntPtr.Zero ? null : Marshal.PtrToStringUni(p);
        }
        catch
        {
            return null; // FILESYSPATH は仮想フォルダーで失敗する（想定内）
        }
        finally
        {
            if (p != IntPtr.Zero) Marshal.FreeCoTaskMem(p);
        }
    }

    private static IShellItem? CreateItem(string parsingName)
    {
        var iid = ShellInterop.IID_IShellItem;
        int hr = ShellInterop.SHCreateItemFromParsingName(parsingName, IntPtr.Zero, ref iid, out var item);
        return hr == 0 ? item : null;
    }
}
