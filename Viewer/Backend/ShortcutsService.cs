using System.IO;
using System.Text.Json;

namespace Viewer.Backend;

/// <summary>
/// ショートカット設定の読み書き（仕様 §8）。exe 隣の shortcuts.json に保存（ポータブル）。
/// 形式は frontend（shortcuts.html / shortcut-dispatch.js）が期待する
/// <c>{ version, bindings: [{ id, shortcut, mouse, gesture }] }</c> をそのまま保持する。
/// 中身は強く型付けせず JsonElement で素通しする（フロントが唯一の真実源）。
/// </summary>
public static class ShortcutsService
{
    private static string Path_ => AppPaths.Combine("shortcuts.json");

    /// <summary>保存済み設定を返す。未存在/失敗時は既定（上書きなし）。</summary>
    public static object Load()
    {
        try
        {
            if (File.Exists(Path_))
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(Path_));
                return doc.RootElement.Clone();
            }
        }
        catch { /* 壊れた設定は無視して既定へ */ }
        return new { version = 1, bindings = Array.Empty<object>() };
    }

    /// <summary>フロントから渡された settings オブジェクトをそのまま保存。</summary>
    public static void Save(JsonElement settings)
    {
        try
        {
            File.WriteAllText(Path_, JsonSerializer.Serialize(settings, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch { /* 保存失敗は致命的でないので無視 */ }
    }
}
