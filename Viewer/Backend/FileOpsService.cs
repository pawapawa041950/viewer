using System.IO;

namespace Viewer.Backend;

/// <summary>
/// ファイル操作のうち、シェル委譲に乗らない軽量なもの（仕様 §2）。
/// コピー/移動/削除はシェル <c>IFileOperation</c>（<see cref="Viewer.Shell.ShellFileOperations"/>）へ委譲済み。
/// リネームは当面プレーン実装（将来シェル委譲に寄せてもよい）。
/// </summary>
public static class FileOpsService
{
    /// <summary>リネーム名の検証（不正文字・空名）。実際の改名はシェルへ委譲（仕様 §2.0）。</summary>
    public static void ValidateNewName(string newName)
    {
        if (string.IsNullOrWhiteSpace(newName))
            throw new InvalidOperationException("名前を入力してください");
        if (newName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            throw new InvalidOperationException("ファイル名に使用できない文字が含まれています");
    }

    /// <summary>更新日時を現在に（Touch）。新しい更新日時（エポックms）を返す（仕様 §2.4）。</summary>
    public static long Touch(string path)
    {
        var now = DateTime.Now;
        if (Directory.Exists(path)) Directory.SetLastWriteTime(path, now);
        else if (File.Exists(path)) File.SetLastWriteTime(path, now);
        else throw new FileNotFoundException("対象が見つかりません", path);

        var utc = Directory.Exists(path)
            ? Directory.GetLastWriteTimeUtc(path)
            : File.GetLastWriteTimeUtc(path);
        return new DateTimeOffset(utc, TimeSpan.Zero).ToUnixTimeMilliseconds();
    }

    /// <summary>新しいフォルダーを一意名で作成して、そのパスを返す（仕様 §2.4）。</summary>
    public static string CreateFolder(string parentPath)
    {
        if (string.IsNullOrEmpty(parentPath) || !Directory.Exists(parentPath))
            throw new InvalidOperationException("フォルダーを作成する場所が見つかりません");

        const string baseName = "新しいフォルダー";
        var target = Path.Combine(parentPath, baseName);
        for (int i = 2; Directory.Exists(target) || File.Exists(target); i++)
            target = Path.Combine(parentPath, $"{baseName} ({i})");

        Directory.CreateDirectory(target);
        return target;
    }
}
