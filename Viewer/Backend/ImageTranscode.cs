using System;
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

    /// <summary>画像バイト列を「最大辺が maxPx」に収まる PNG サムネイルへ縮小する。
    /// 元画像が既に maxPx 以下、または変換失敗時は null（呼び出し側は原本をそのまま配信）。
    /// WIC の縮小デコード（DecodePixelWidth）を使うため、巨大画像でもフルデコードせず低負荷・低メモリ。
    /// 一覧のサムネイル表示時にのみ使い、ビューワー等のフル表示には使わない（仕様 §3）。</summary>
    public static byte[]? MakeThumbnail(byte[] src, int maxPx)
    {
        if (src == null || src.Length == 0 || maxPx <= 0) return null;
        try
        {
            // まずヘッダだけ読んで元寸を取得（フルデコードしない）。
            int srcW, srcH;
            using (var probe = new MemoryStream(src, writable: false))
            {
                var dec = BitmapDecoder.Create(probe,
                    BitmapCreateOptions.DelayCreation | BitmapCreateOptions.IgnoreColorProfile,
                    BitmapCacheOption.None);
                if (dec.Frames.Count == 0) return null;
                srcW = dec.Frames[0].PixelWidth;
                srcH = dec.Frames[0].PixelHeight;
            }
            if (srcW <= 0 || srcH <= 0) return null;
            int maxDim = Math.Max(srcW, srcH);
            if (maxDim <= maxPx) return null; // 小さい画像はそのまま（原本配信で十分軽い）

            double scale = (double)maxPx / maxDim;
            int dpw = Math.Max(1, (int)Math.Round(srcW * scale)); // 横基準で縮小デコード（縦横比は自動維持）

            using var ms = new MemoryStream(src, writable: false);
            var bmp = new BitmapImage();
            bmp.BeginInit();
            bmp.CacheOption = BitmapCacheOption.OnLoad;
            bmp.CreateOptions = BitmapCreateOptions.IgnoreColorProfile;
            bmp.DecodePixelWidth = dpw;
            bmp.StreamSource = ms;
            bmp.EndInit();
            bmp.Freeze();

            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(bmp));
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
