using System.IO;
using Microsoft.VisualBasic.FileIO;

namespace Viewer.Backend;

/// <summary>
/// ファイル操作（仕様 §2）。当面は最小実装。
/// 将来はコピー/移動/削除/リネームを完全にシェル <c>IFileOperation</c> へ委譲し、
/// 進捗・競合・Ctrl+Z 取り消しまで Explorer と一致させる（仕様 §2.0）。
/// 現段階では削除はゴミ箱（シェル既定の確認/進捗 UI 経由）にしている。
/// </summary>
public static class FileOpsService
{
    /// <summary>選択をゴミ箱へ。戻り値は処理件数。</summary>
    public static int MoveToTrash(IEnumerable<string> paths)
    {
        int count = 0;
        foreach (var p in paths)
        {
            try
            {
                if (Directory.Exists(p))
                {
                    FileSystem.DeleteDirectory(p, UIOption.OnlyErrorDialogs, RecycleOption.SendToRecycleBin);
                    count++;
                }
                else if (File.Exists(p))
                {
                    FileSystem.DeleteFile(p, UIOption.OnlyErrorDialogs, RecycleOption.SendToRecycleBin);
                    count++;
                }
            }
            catch { /* 個別失敗は無視して続行 */ }
        }
        return count;
    }

    /// <summary>リネーム。新パスを返す。不正文字・衝突は例外メッセージで弾く（仕様 §2.1）。</summary>
    public static string RenameFile(string oldPath, string newName)
    {
        if (string.IsNullOrWhiteSpace(newName))
            throw new InvalidOperationException("名前を入力してください");
        if (newName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            throw new InvalidOperationException("ファイル名に使用できない文字が含まれています");

        var dir = Path.GetDirectoryName(oldPath)
                  ?? throw new InvalidOperationException("親フォルダーを特定できませんでした");
        var newPath = Path.Combine(dir, newName);

        if (File.Exists(newPath) || Directory.Exists(newPath))
            throw new InvalidOperationException("同名のファイルまたはフォルダーが既に存在します");

        if (Directory.Exists(oldPath)) Directory.Move(oldPath, newPath);
        else File.Move(oldPath, newPath);
        return newPath;
    }
}
