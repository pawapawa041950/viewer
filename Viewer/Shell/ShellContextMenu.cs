using System.Runtime.InteropServices;
using System.Windows.Interop;

namespace Viewer.Shell;

/// <summary>
/// Explorer と同じネイティブのシェルコンテキストメニュー（仕様 §2.3「一般メニュー」）。
/// 選択ファイル群の <c>IContextMenu</c> を <c>IShellItemArray.BindToHandler(BHID_SFUIObject)</c>
/// で取得してカーソル位置に表示し、選んだコマンドを実行する。
/// 「送る」「新規」「プログラムから開く」等の動的サブメニューのため
/// <c>IContextMenu2/3</c> のメニューメッセージ（WM_INITMENUPOPUP 等）をオーナーへ転送する。
/// STA（UI スレッド）で呼ぶこと。
/// </summary>
public static class ShellContextMenu
{
    public static void Show(IReadOnlyList<string> paths, IntPtr owner)
    {
        var absPidls = ParsePidls(paths);
        if (absPidls.Count == 0) return;

        IContextMenu? cm = null;
        IntPtr hMenu = IntPtr.Zero;
        HwndSource? src = null;
        HwndSourceHook? hook = null;
        try
        {
            cm = AcquireContextMenu(absPidls);
            if (cm == null) return;

            var cm2 = cm as IContextMenu2;
            var cm3 = cm as IContextMenu3;

            hMenu = CreatePopupMenu();
            if (hMenu == IntPtr.Zero) return;
            cm.QueryContextMenu(hMenu, 0, IdCmdFirst, IdCmdLast, CMF_NORMAL | CMF_EXPLORE);

            // 動的サブメニューのためメニューメッセージを IContextMenu2/3 へ転送。
            src = HwndSource.FromHwnd(owner);
            hook = (IntPtr h, int msg, IntPtr w, IntPtr l, ref bool handled) =>
            {
                switch (msg)
                {
                    case WM_INITMENUPOPUP:
                    case WM_DRAWITEM:
                    case WM_MEASUREITEM:
                    case WM_MENUCHAR:
                        if (cm3 != null && cm3.HandleMenuMsg2((uint)msg, w, l, out var res) >= 0) { handled = true; return res; }
                        if (cm2 != null && cm2.HandleMenuMsg((uint)msg, w, l) >= 0) { handled = true; return msg == WM_INITMENUPOPUP ? IntPtr.Zero : (IntPtr)1; }
                        break;
                }
                return IntPtr.Zero;
            };
            src?.AddHook(hook);

            GetCursorPos(out var pt);
            uint cmd = TrackPopupMenuEx(hMenu, TPM_RETURNCMD | TPM_RIGHTBUTTON, pt.X, pt.Y, owner, IntPtr.Zero);

            if (hook != null) { src?.RemoveHook(hook); hook = null; }

            if (cmd >= IdCmdFirst)
            {
                var ici = new ShellContextMenu_CMINVOKE
                {
                    cbSize = Marshal.SizeOf<ShellContextMenu_CMINVOKE>(),
                    hwnd = owner,
                    lpVerb = (IntPtr)(cmd - IdCmdFirst),
                    nShow = SW_SHOWNORMAL,
                };
                cm.InvokeCommand(ref ici);
            }
        }
        finally
        {
            if (hook != null) src?.RemoveHook(hook);
            if (hMenu != IntPtr.Zero) DestroyMenu(hMenu);
            if (cm != null) Marshal.ReleaseComObject(cm);
            foreach (var p in absPidls) Marshal.FreeCoTaskMem(p);
        }
    }

    private static List<IntPtr> ParsePidls(IReadOnlyList<string> paths)
    {
        var list = new List<IntPtr>();
        foreach (var p in paths)
            if (SHParseDisplayName(p, IntPtr.Zero, out var pidl, 0, out _) >= 0 && pidl != IntPtr.Zero)
                list.Add(pidl);
        return list;
    }

    /// <summary>絶対 PIDL 群から IShellItemArray を作り、BHID_SFUIObject で IContextMenu を得る。</summary>
    private static IContextMenu? AcquireContextMenu(List<IntPtr> absPidls)
    {
        if (SHCreateShellItemArrayFromIDLists((uint)absPidls.Count, absPidls.ToArray(), out var arr) < 0 || arr == null)
            return null;
        try
        {
            var bhid = BHID_SFUIObject;
            var iid = IID_IContextMenu;
            if (arr.BindToHandler(IntPtr.Zero, ref bhid, ref iid, out var pcm) < 0 || pcm == IntPtr.Zero)
                return null;
            var cm = (IContextMenu)Marshal.GetObjectForIUnknown(pcm);
            Marshal.Release(pcm);
            return cm;
        }
        finally { Marshal.ReleaseComObject(arr); }
    }

    // ---- 定数 ----
    private const uint IdCmdFirst = 1;
    private const uint IdCmdLast = 0x7FFF;
    private const uint CMF_NORMAL = 0x0;
    private const uint CMF_EXPLORE = 0x4;
    private const uint TPM_RETURNCMD = 0x0100;
    private const uint TPM_RIGHTBUTTON = 0x0002;
    private const int SW_SHOWNORMAL = 1;
    private const int WM_INITMENUPOPUP = 0x0117;
    private const int WM_DRAWITEM = 0x002B;
    private const int WM_MEASUREITEM = 0x002C;
    private const int WM_MENUCHAR = 0x0120;

    private static Guid IID_IContextMenu = new("000214e4-0000-0000-c000-000000000046");
    private static Guid BHID_SFUIObject = new("3981e225-f559-11d3-8e3a-00c04f6837d5");

    // ---- P/Invoke ----
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHParseDisplayName(string name, IntPtr pbc, out IntPtr ppidl, uint sfgaoIn, out uint psfgaoOut);

    [DllImport("shell32.dll")]
    private static extern int SHCreateShellItemArrayFromIDLists(uint cidl, [In] IntPtr[] rgpidl,
        [MarshalAs(UnmanagedType.Interface)] out IShellItemArray ppsiItemArray);

    [DllImport("user32.dll")] private static extern IntPtr CreatePopupMenu();
    [DllImport("user32.dll")] private static extern bool DestroyMenu(IntPtr hMenu);
    [DllImport("user32.dll")]
    private static extern uint TrackPopupMenuEx(IntPtr hmenu, uint flags, int x, int y, IntPtr hwnd, IntPtr lptpm);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT pt);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }
}

// ---- COM インターフェイス（vtable 順を厳守） ----

[ComImport, Guid("b63ea76d-1f85-456f-a19c-48159efa858b"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IShellItemArray
{
    [PreserveSig] int BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppvOut);
    [PreserveSig] int GetPropertyStore(int flags, ref Guid riid, out IntPtr ppv);
    [PreserveSig] int GetPropertyDescriptionList(IntPtr keyType, ref Guid riid, out IntPtr ppv);
    [PreserveSig] int GetAttributes(int attribFlags, uint sfgaoMask, out uint psfgaoAttribs);
    [PreserveSig] int GetCount(out uint pdwNumItems);
    [PreserveSig] int GetItemAt(uint dwIndex, out IntPtr ppsi);
    [PreserveSig] int EnumItems(out IntPtr ppenumShellItems);
}

[ComImport, Guid("000214e4-0000-0000-c000-000000000046"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IContextMenu
{
    [PreserveSig] int QueryContextMenu(IntPtr hMenu, uint indexMenu, uint idCmdFirst, uint idCmdLast, uint uFlags);
    [PreserveSig] int InvokeCommand(ref ShellContextMenu_CMINVOKE pici);
    [PreserveSig] int GetCommandString(UIntPtr idCmd, uint uType, IntPtr pReserved, [Out] byte[] pszName, uint cchMax);
}

[ComImport, Guid("000214f4-0000-0000-c000-000000000046"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IContextMenu2
{
    [PreserveSig] int QueryContextMenu(IntPtr hMenu, uint indexMenu, uint idCmdFirst, uint idCmdLast, uint uFlags);
    [PreserveSig] int InvokeCommand(ref ShellContextMenu_CMINVOKE pici);
    [PreserveSig] int GetCommandString(UIntPtr idCmd, uint uType, IntPtr pReserved, [Out] byte[] pszName, uint cchMax);
    [PreserveSig] int HandleMenuMsg(uint uMsg, IntPtr wParam, IntPtr lParam);
}

[ComImport, Guid("bcfce0a0-ec17-11d0-8d10-00a0c90f2719"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IContextMenu3
{
    [PreserveSig] int QueryContextMenu(IntPtr hMenu, uint indexMenu, uint idCmdFirst, uint idCmdLast, uint uFlags);
    [PreserveSig] int InvokeCommand(ref ShellContextMenu_CMINVOKE pici);
    [PreserveSig] int GetCommandString(UIntPtr idCmd, uint uType, IntPtr pReserved, [Out] byte[] pszName, uint cchMax);
    [PreserveSig] int HandleMenuMsg(uint uMsg, IntPtr wParam, IntPtr lParam);
    [PreserveSig] int HandleMenuMsg2(uint uMsg, IntPtr wParam, IntPtr lParam, out IntPtr plResult);
}

/// <summary>IContextMenu.InvokeCommand 用（インターフェイス定義から参照するため独立型）。</summary>
[StructLayout(LayoutKind.Sequential)]
internal struct ShellContextMenu_CMINVOKE
{
    public int cbSize;
    public int fMask;
    public IntPtr hwnd;
    public IntPtr lpVerb;
    [MarshalAs(UnmanagedType.LPStr)] public string? lpParameters;
    [MarshalAs(UnmanagedType.LPStr)] public string? lpDirectory;
    public int nShow;
    public int dwHotKey;
    public IntPtr hIcon;
}
