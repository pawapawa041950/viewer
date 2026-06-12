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

    // GetImage が返す HBITMAP は 32bpp 乗算済みアルファの DIB セクション。ビットから
    // Pbgra32 の BitmapSource を作る（アルファ保持＝透過が黒くならない）。DIB は環境により
    // ボトムアップ（biHeight>0）で格納されることがあり、その場合は上下反転して返す
    // （＝アイコンが上下逆になる問題の対策）。
    private static ImageSource? FromHBitmap(IntPtr hbm)
    {
        var ds = new DIBSECTION();
        if (GetObject(hbm, Marshal.SizeOf<DIBSECTION>(), ref ds) == 0
            || ds.dsBm.bmBits == IntPtr.Zero || ds.dsBm.bmBitsPixel != 32)
            return null;

        int stride = ds.dsBm.bmWidthBytes;
        int length = stride * ds.dsBm.bmHeight;
        var src = BitmapSource.Create(
            ds.dsBm.bmWidth, ds.dsBm.bmHeight, 96, 96, PixelFormats.Pbgra32, null, ds.dsBm.bmBits, length, stride);
        src.Freeze();

        // biHeight > 0 = ボトムアップ格納（メモリ先頭が最下行）。トップダウン読みすると
        // 上下逆になるので反転する。biHeight < 0 = トップダウンなのでそのまま。
        if (ds.dsBmih.biHeight > 0)
        {
            var flipped = new TransformedBitmap(src, new ScaleTransform(1, -1));
            flipped.Freeze();
            return flipped;
        }
        return src;
    }

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

    [StructLayout(LayoutKind.Sequential)]
    private struct DIBSECTION
    {
        public BITMAP dsBm;
        public BITMAPINFOHEADER dsBmih;
        public uint dsBitfield0;
        public uint dsBitfield1;
        public uint dsBitfield2;
        public IntPtr dshSection;
        public uint dsOffset;
    }

    [DllImport("gdi32.dll")]
    private static extern int GetObject(IntPtr hObject, int nCount, ref DIBSECTION lpObject);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr hObject);
}
