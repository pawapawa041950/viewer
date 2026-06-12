using System.IO;
using System.Windows.Media.Imaging;

namespace Viewer.Backend;

/// <summary>
/// Chromium が直接表示できない画像形式の変換（仕様 §3）。
/// 現状 TIFF のみ：WIC（WPF Imaging）で PNG へ変換して WebView2 に配信する。
/// </summary>
public static class ImageTranscode
{
    /// <summary>TIFF バイト列を PNG バイト列へ変換。失敗時は null。</summary>
    public static byte[]? TiffToPng(byte[] tiff)
    {
        try
        {
            using var inMs = new MemoryStream(tiff, writable: false);
            var decoder = BitmapDecoder.Create(inMs,
                BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad);
            if (decoder.Frames.Count == 0) return null;

            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(decoder.Frames[0]));
            using var outMs = new MemoryStream();
            encoder.Save(outMs);
            return outMs.ToArray();
        }
        catch
        {
            return null;
        }
    }
}
