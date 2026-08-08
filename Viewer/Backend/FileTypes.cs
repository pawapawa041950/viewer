namespace Viewer.Backend;

/// <summary>
/// 対応拡張子の判定（仕様 §10）。現行 Rust の IMAGE_EXTENSIONS / ARCHIVE_EXTENSIONS と一致させる。
/// </summary>
public static class FileTypes
{
    private static readonly HashSet<string> ImageExts = new(StringComparer.OrdinalIgnoreCase)
    {
        "jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif",
    };

    private static readonly HashSet<string> ArchiveExts = new(StringComparer.OrdinalIgnoreCase)
    {
        "zip", "7z", "rar",
    };

    // 動画（サムネイルはシェル＝Explorer と同じハンドラで生成するため、ここに無い形式でも
    // OS が対応していれば拡張子を足すだけで表示できる）。
    private static readonly HashSet<string> VideoExts = new(StringComparer.OrdinalIgnoreCase)
    {
        "mp4", "m4v", "mov", "avi", "wmv", "mkv", "webm",
        "mpg", "mpeg", "ts", "m2ts", "3gp", "flv",
    };

    public static bool IsImage(string path) => ImageExts.Contains(Ext(path));
    public static bool IsArchive(string path) => ArchiveExts.Contains(Ext(path));
    public static bool IsVideo(string path) => VideoExts.Contains(Ext(path));

    /// <summary>Chromium が直接表示できない画像か（仕様 §3：TIFF は要変換）。</summary>
    public static bool NeedsTranscode(string path)
    {
        var e = Ext(path);
        return e is "tif" or "tiff";
    }

    private static string Ext(string path)
    {
        var e = System.IO.Path.GetExtension(path);
        return e.Length > 0 ? e[1..] : e; // 先頭の '.' を除去
    }
}
