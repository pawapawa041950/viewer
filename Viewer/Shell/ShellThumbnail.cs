using System.IO;
using System.Windows.Media.Imaging;

namespace Viewer.Shell;

/// <summary>
/// シェルのサムネイル（<c>IShellItemImageFactory</c>）を PNG バイト列で取得する（仕様 §3）。
/// Explorer と同じサムネイルハンドラ／キャッシュを使うため、動画（Media Foundation 対応形式）
/// など Explorer でサムネイルが出るファイルはすべて同じ見た目で取得できる。
/// サムネイルを作れないファイルは null（アイコンへはフォールバックしない。呼び出し側が
/// 「サムネ無し」表示＝一覧の中央バッジ等に切り替えるため）。
/// ファイルパス起点なので MTA（リソース配信のバックグラウンドスレッド）から呼んで良い。
/// </summary>
internal static class ShellThumbnail
{
    /// <summary>path のサムネイルを最大辺 maxPx 程度の PNG で返す。失敗時 null。</summary>
    public static byte[]? GetPng(string path, int maxPx)
    {
        IntPtr hbm = IntPtr.Zero;
        try
        {
            var iid = ShellInterop.IID_IShellItem;
            if (ShellInterop.SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out var item) != 0 || item == null)
                return null;
            var factory = (IShellItemImageFactory)item;
            var sz = new ShellInterop.SIZE { cx = maxPx, cy = maxPx };
            // THUMBNAILONLY＝サムネイルを作れない場合は失敗させる（アイコンで誤魔化さない）。
            // BIGGERSIZEOK でキャッシュ済みの大きめサムネイルをそのまま貰う（縮小は表示側の <img> が行う）。
            int hr = factory.GetImage(
                sz, ShellInterop.SIIGBF.THUMBNAILONLY | ShellInterop.SIIGBF.BIGGERSIZEOK, out hbm);
            if (hr != 0 || hbm == IntPtr.Zero) return null;

            var src = ShellIcon.FromHBitmap(hbm);
            if (src == null) return null;
            var enc = new PngBitmapEncoder();
            enc.Frames.Add(BitmapFrame.Create(src));
            using var ms = new MemoryStream();
            enc.Save(ms);
            return ms.ToArray();
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

    [System.Runtime.InteropServices.DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr hObject);
}
