using System.IO;
using SharpCompress.Archives;

namespace Viewer.Backend;

/// <summary>
/// 書庫（ZIP/7z/RAR）の閲覧（仕様 §5）。SharpCompress（MIT）で読み取り専用。
/// テンポラリ書き出しなしのメモリ展開。暗号化書庫・分割書庫は対象外（B.5）。
/// 内部パスは UI 側と揃えて '\' 区切りで返し、照合時に '/' へ正規化する。
/// </summary>
public static class ArchiveService
{
    /// <summary>書庫内の <paramref name="innerPath"/> 直下のエントリ（フォルダー先頭）。</summary>
    public static List<ArchiveEntry> ListEntries(string archivePath, string innerPath)
    {
        var dirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var files = new List<ArchiveEntry>();

        var innerNorm = Norm(innerPath);
        var prefix = innerNorm.Length == 0 ? "" : innerNorm + "/";

        try
        {
            using var archive = ArchiveFactory.OpenArchive(archivePath);
            foreach (var e in archive.Entries)
            {
                var key = Norm(e.Key ?? "");
                if (key.Length == 0) continue;

                if (prefix.Length > 0 && !key.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                    continue;

                var rest = key[prefix.Length..];
                if (rest.Length == 0) continue;

                int slash = rest.IndexOf('/');
                if (slash >= 0)
                {
                    // サブフォルダー（中間ディレクトリを合成）
                    dirs.Add(rest[..slash]);
                }
                else if (e.IsDirectory)
                {
                    dirs.Add(rest);
                }
                else
                {
                    var full = ToWin(prefix + rest);
                    files.Add(new ArchiveEntry
                    {
                        Path = full,
                        Name = rest,
                        IsDir = false,
                        IsImage = FileTypes.IsImage(rest),
                        Size = e.Size,
                    });
                }
            }
        }
        catch
        {
            // 暗号化/分割/破損などは対象外。空で返す。
            return new List<ArchiveEntry>();
        }

        var result = new List<ArchiveEntry>();
        foreach (var d in dirs.OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
            result.Add(new ArchiveEntry { Path = ToWin(prefix + d), Name = d, IsDir = true });

        files.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase));
        result.AddRange(files);
        return result;
    }

    /// <summary>書庫内の「1 枚目の画像」の内部パス（'\' 区切り）。名前昇順で先頭。無ければ null。
    /// サムネイル表示用。<paramref name="innerPath"/> を指定すると、その内部フォルダー配下
    /// （任意の深さ）に限定して探す＝書庫内フォルダーのサムネイル用。空＝書庫全体。</summary>
    public static string? FirstImageEntry(string archivePath, string innerPath = "")
    {
        var innerNorm = Norm(innerPath);
        var prefix = innerNorm.Length == 0 ? "" : innerNorm + "/";
        try
        {
            using var archive = ArchiveFactory.OpenArchive(archivePath);
            string? best = null;
            foreach (var e in archive.Entries)
            {
                if (e.IsDirectory) continue;
                var key = Norm(e.Key ?? "");
                if (key.Length == 0 || !FileTypes.IsImage(key)) continue;
                if (prefix.Length > 0 && !key.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) continue;
                var win = ToWin(key);
                if (best == null || string.Compare(win, best, StringComparison.OrdinalIgnoreCase) < 0)
                    best = win;
            }
            return best;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>書庫内エントリ 1 件をメモリへ展開。見つからなければ null。</summary>
    public static byte[]? ReadEntry(string archivePath, string innerPath)
    {
        var target = Norm(innerPath);
        if (target.Length == 0) return null;
        try
        {
            using var archive = ArchiveFactory.OpenArchive(archivePath);
            foreach (var e in archive.Entries)
            {
                if (e.IsDirectory) continue;
                if (!Norm(e.Key ?? "").Equals(target, StringComparison.OrdinalIgnoreCase)) continue;

                using var s = e.OpenEntryStream();
                using var ms = new MemoryStream();
                s.CopyTo(ms);
                return ms.ToArray();
            }
        }
        catch
        {
            return null;
        }
        return null;
    }

    private static string Norm(string s) => s.Replace('\\', '/').Trim('/');
    private static string ToWin(string s) => s.Replace('/', '\\');
}
