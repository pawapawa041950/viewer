using System.Runtime.InteropServices;

namespace Viewer.Shell;

/// <summary>
/// シェル名前空間ツリー（仕様 §1.2 / C.6）の COM 相互運用。
/// 外部ライブラリに依存せず（ライセンスをクリーンに保つため）、
/// Vista 以降の <c>IShellItem</c> / <c>IEnumShellItems</c> を直接 P/Invoke する。
/// </summary>
internal static class ShellInterop
{
    // BHID_EnumItems — 子の列挙ハンドラ
    public static Guid BHID_EnumItems = new("94f60519-2850-4924-aa5a-d15e84868039");
    public static Guid IID_IEnumShellItems = new("70629033-e363-4a28-a567-0db78006e6d7");
    public static Guid IID_IShellItem = new("43826d1e-e718-42ee-bc55-a1e261c37bfe");

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    public static extern int SHCreateItemFromParsingName(
        string pszPath, IntPtr pbc, ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);

    [Flags]
    public enum SFGAO : uint
    {
        HIDDEN = 0x00080000,
        FOLDER = 0x20000000,
        FILESYSTEM = 0x40000000,
        HASSUBFOLDER = 0x80000000,
    }

    public enum SIGDN : uint
    {
        NORMALDISPLAY = 0x00000000,
        FILESYSPATH = 0x80058000,
        DESKTOPABSOLUTEPARSING = 0x80028000,
    }

    // IShellItemImageFactory（アイコン/サムネイル取得）。ツリーの各ノードのアイコンに使う。
    public static Guid IID_IShellItemImageFactory = new("bcc18b79-ba16-442f-80c4-8a59c30c463b");

    [StructLayout(LayoutKind.Sequential)]
    public struct SIZE { public int cx; public int cy; }

    [Flags]
    public enum SIIGBF
    {
        RESIZETOFIT = 0x00,
        BIGGERSIZEOK = 0x01,
        ICONONLY = 0x04,   // サムネイルではなくアイコンを取得
    }
}

[ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IShellItemImageFactory
{
    [PreserveSig] int GetImage(ShellInterop.SIZE size, ShellInterop.SIIGBF flags, out IntPtr phbm);
}

[ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IShellItem
{
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(ShellInterop.SIGDN sigdnName, out IntPtr ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
}

[ComImport, Guid("70629033-e363-4a28-a567-0db78006e6d7"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IEnumShellItems
{
    [PreserveSig]
    int Next(uint celt, [MarshalAs(UnmanagedType.Interface)] out IShellItem rgelt, out uint pceltFetched);
    [PreserveSig] int Skip(uint celt);
    [PreserveSig] int Reset();
    void Clone(out IEnumShellItems ppenum);
}

/// <summary>
/// シェルのファイル操作（仕様 §2.0 / A.2）。コピー/移動/削除を委譲すると
/// 進捗ダイアログ・競合解決・取り消し（Ctrl+Z）まで Explorer と一致する。
/// 未使用のインターフェイス引数（progress sink / property array 等）は IntPtr で受け、null を渡す。
/// vtable 順は shobjidl の定義どおりに保つこと（並べ替え不可）。
/// </summary>
[ComImport, Guid("947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IFileOperation
{
    [PreserveSig] int Advise(IntPtr sink, out uint cookie);
    [PreserveSig] int Unadvise(uint cookie);
    [PreserveSig] int SetOperationFlags(uint flags);
    [PreserveSig] int SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string msg);
    [PreserveSig] int SetProgressDialog(IntPtr dlg);
    [PreserveSig] int SetProperties(IntPtr props);
    [PreserveSig] int SetOwnerWindow(IntPtr hwnd);
    [PreserveSig] int ApplyPropertiesToItem(IShellItem item);
    [PreserveSig] int ApplyPropertiesToItems(IntPtr items);
    [PreserveSig] int RenameItem(IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string newName, IntPtr sink);
    [PreserveSig] int RenameItems(IntPtr items, [MarshalAs(UnmanagedType.LPWStr)] string newName);
    [PreserveSig] int MoveItem(IShellItem item, IShellItem dest, [MarshalAs(UnmanagedType.LPWStr)] string? newName, IntPtr sink);
    [PreserveSig] int MoveItems(IntPtr items, IShellItem dest);
    [PreserveSig] int CopyItem(IShellItem item, IShellItem dest, [MarshalAs(UnmanagedType.LPWStr)] string? copyName, IntPtr sink);
    [PreserveSig] int CopyItems(IntPtr items, IShellItem dest);
    [PreserveSig] int DeleteItem(IShellItem item, IntPtr sink);
    [PreserveSig] int DeleteItems(IntPtr items);
    [PreserveSig] int NewItem(IShellItem dest, uint attrs, [MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.LPWStr)] string? template, IntPtr sink);
    [PreserveSig] int PerformOperations();
    [PreserveSig] int GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
}
