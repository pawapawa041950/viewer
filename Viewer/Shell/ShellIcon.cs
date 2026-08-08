using System.Runtime.InteropServices;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace Viewer.Shell;

/// <summary>
/// シェル項目（IShellItem）のアイコンを WPF の <see cref="ImageSource"/> として取得する（仕様 §1.2）。
/// 仮想フォルダー（ホーム/ギャラリー/PC/ネットワーク等）でもアイコンが取れる
/// <c>IShellItemImageFactory</c> を使う。STA（UI スレッド）で呼ぶこと。
/// </summary>
internal static class ShellIcon
{
    /// <summary>項目のアイコンを返す。失敗時 null。</summary>
    public static ImageSource? Get(IShellItem item, int size = 16)
    {
        IntPtr hbm = IntPtr.Zero;
        try
        {
            var factory = (IShellItemImageFactory)item; // QueryInterface（非対応なら InvalidCastException）
            var sz = new ShellInterop.SIZE { cx = size, cy = size };
            int hr = factory.GetImage(sz, ShellInterop.SIIGBF.ICONONLY, out hbm);
            if (hr != 0 || hbm == IntPtr.Zero) return null;
            return FromHBitmap(hbm);
        }
        catch
        {
            return null;
        }
        finally
        {
            if (hbm != IntPtr.Zero) DeleteObject(hbm);
        }
    }

    // GetImage が返す HBITMAP（32bpp 乗算済みアルファ）から Pbgra32 の BitmapSource を作る。
    // ピクセルは GetDIBits に「トップダウン（負の高さ）」で要求して取り出す：DIB の格納方向は
    // ソースにより異なり（アイコン=ボトムアップ、動画サムネイル=トップダウンの実例あり、
    // どちらも biHeight>0 を名乗る）、生ビット読み＋biHeight 符号の反転推測では両立できない。
    // GetDIBits なら格納方向の解決を GDI が行うため常に正しい向きになる。
    // ShellThumbnail（動画サムネイル）とも共用。
    internal static BitmapSource? FromHBitmap(IntPtr hbm)
    {
        var bm = new BITMAP();
        if (GetObject(hbm, Marshal.SizeOf<BITMAP>(), ref bm) == 0 || bm.bmWidth <= 0 || bm.bmHeight <= 0)
            return null;

        int w = bm.bmWidth, h = bm.bmHeight, stride = w * 4;
        var bi = new BITMAPINFOHEADER
        {
            biSize = (uint)Marshal.SizeOf<BITMAPINFOHEADER>(),
            biWidth = w,
            biHeight = -h, // 負 = トップダウンで受け取る
            biPlanes = 1,
            biBitCount = 32,
            biCompression = 0, // BI_RGB
        };
        var buf = new byte[stride * h];
        IntPtr dc = GetDC(IntPtr.Zero);
        try
        {
            if (GetDIBits(dc, hbm, 0, (uint)h, buf, ref bi, DIB_RGB_COLORS) == 0) return null;
        }
        finally
        {
            ReleaseDC(IntPtr.Zero, dc);
        }
        var src = BitmapSource.Create(w, h, 96, 96, PixelFormats.Pbgra32, null, buf, stride);
        src.Freeze();
        return src;
    }

    private const uint DIB_RGB_COLORS = 0;

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAP
    {
        public int bmType;
        public int bmWidth;
        public int bmHeight;
        public int bmWidthBytes;
        public ushort bmPlanes;
        public ushort bmBitsPixel;
        public IntPtr bmBits;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFOHEADER
    {
        public uint biSize;
        public int biWidth;
        public int biHeight;
        public ushort biPlanes;
        public ushort biBitCount;
        public uint biCompression;
        public uint biSizeImage;
        public int biXPelsPerMeter;
        public int biYPelsPerMeter;
        public uint biClrUsed;
        public uint biClrImportant;
    }

    [DllImport("gdi32.dll")]
    private static extern int GetObject(IntPtr hObject, int nCount, ref BITMAP lpObject);

    [DllImport("gdi32.dll")]
    private static extern int GetDIBits(
        IntPtr hdc, IntPtr hbm, uint start, uint cLines, byte[] lpvBits, ref BITMAPINFOHEADER lpbmi, uint usage);

    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr hObject);
}
