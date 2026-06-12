using System.IO;
using System.Runtime.InteropServices;

namespace Viewer.Shell;

/// <summary>
/// シェル <c>IFileOperation</c> によるファイル操作（仕様 §2.0 / A.2）。
/// コピー/移動/削除を委譲することで、進捗ダイアログ・競合解決・取り消し（Ctrl+Z）を
/// Explorer と完全一致させる。同一フォルダーへのコピー時の「- コピー」連番付与等も
/// シェルの標準挙動がそのまま適用される。
///
/// COM は STA で扱う必要があるため、呼び出しは UI スレッドから行うこと
/// （IPC ハンドラは WebView2 生成スレッド＝UI で発火するため条件を満たす）。
/// </summary>
public static class ShellFileOperations
{
    // FOF_* / FOFX_* フラグ
    private const uint FOF_RENAMEONCOLLISION = 0x0008; // 名前衝突時に自動リネーム（Explorer の「- コピー」）
    private const uint FOF_ALLOWUNDO = 0x0040;          // ごみ箱・取り消し有効
    private const uint FOF_NOCONFIRMMKDIR = 0x0200;     // 中間フォルダー作成を確認しない
    private const uint FOFX_RECYCLEONDELETE = 0x00080000; // 削除をごみ箱へ

    private static readonly Guid CLSID_FileOperation = new("3ad05575-8857-4850-9277-11b85bdb8e09");

    /// <summary>コピー。戻り値は要求件数（実際の成否はシェル UI 側で扱われる）。
    /// <paramref name="renameOnCollision"/>=true で名前衝突時に自動リネーム（同一フォルダー貼り付け用・仕様 §2.1）。</summary>
    public static int Copy(IReadOnlyList<string> sources, string destFolder, IntPtr owner, bool renameOnCollision = false)
        => Run(sources, destFolder, owner,
               FOF_ALLOWUNDO | FOF_NOCONFIRMMKDIR | (renameOnCollision ? FOF_RENAMEONCOLLISION : 0),
               (op, item, dest) => op.CopyItem(item, dest, null, IntPtr.Zero));

    /// <summary>移動。</summary>
    public static int Move(IReadOnlyList<string> sources, string destFolder, IntPtr owner)
        => Run(sources, destFolder, owner, FOF_ALLOWUNDO | FOF_NOCONFIRMMKDIR,
               (op, item, dest) => op.MoveItem(item, dest, null, IntPtr.Zero));

    /// <summary>リネーム（仕様 §2.0：シェル委譲。取り消し可）。</summary>
    public static void Rename(string path, string newName, IntPtr owner)
    {
        var op = CreateOp(FOF_ALLOWUNDO, owner);
        try
        {
            var item = CreateItem(path) ?? throw new IOException($"対象を解決できません: {path}");
            Check(op.RenameItem(item, newName, IntPtr.Zero));
            Check(op.PerformOperations());
        }
        finally { Marshal.ReleaseComObject(op); }
    }

    /// <summary>ごみ箱へ削除（仕様 §2.1）。</summary>
    public static int Recycle(IReadOnlyList<string> paths, IntPtr owner)
    {
        if (paths.Count == 0) return 0;
        var op = CreateOp(FOF_ALLOWUNDO | FOFX_RECYCLEONDELETE, owner);
        try
        {
            int n = 0;
            foreach (var p in paths)
            {
                var item = CreateItem(p);
                if (item == null) continue;
                Check(op.DeleteItem(item, IntPtr.Zero));
                n++;
            }
            Check(op.PerformOperations());
            return n;
        }
        finally { Marshal.ReleaseComObject(op); }
    }

    private static int Run(IReadOnlyList<string> sources, string destFolder, IntPtr owner,
        uint flags, Func<IFileOperation, IShellItem, IShellItem, int> action)
    {
        if (sources.Count == 0) return 0;
        var op = CreateOp(flags, owner);
        try
        {
            var dest = CreateItem(destFolder) ?? throw new IOException($"宛先を解決できません: {destFolder}");
            int n = 0;
            foreach (var s in sources)
            {
                var item = CreateItem(s);
                if (item == null) continue;
                Check(action(op, item, dest));
                n++;
            }
            Check(op.PerformOperations());
            return n;
        }
        finally { Marshal.ReleaseComObject(op); }
    }

    private static IFileOperation CreateOp(uint flags, IntPtr owner)
    {
        var t = Type.GetTypeFromCLSID(CLSID_FileOperation)
                ?? throw new InvalidOperationException("FileOperation CLSID 解決失敗");
        var op = (IFileOperation)Activator.CreateInstance(t)!;
        Check(op.SetOperationFlags(flags));
        if (owner != IntPtr.Zero) op.SetOwnerWindow(owner);
        return op;
    }

    private static IShellItem? CreateItem(string path)
    {
        var iid = ShellInterop.IID_IShellItem;
        int hr = ShellInterop.SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out var item);
        return hr >= 0 ? item : null;
    }

    private static void Check(int hr)
    {
        if (hr < 0) Marshal.ThrowExceptionForHR(hr);
    }
}
