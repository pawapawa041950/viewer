using System.IO;
using Tomlyn;

namespace Viewer.Backend;

/// <summary>
/// 設定の読み書き（仕様 §9）。exe 隣の settings.toml に Tomlyn で保存（D.8: TOML 維持）。
/// 読み込み失敗・未存在時は既定値を返す（壊れた設定で起動不能にしない）。
/// </summary>
public static class SettingsService
{
    private static string Path_ => AppPaths.Combine("settings.toml");

    public static AppSettings Load()
    {
        try
        {
            if (!File.Exists(Path_)) return new AppSettings();
            var text = File.ReadAllText(Path_);
            return Toml.ToModel<AppSettings>(text) ?? new AppSettings();
        }
        catch
        {
            return new AppSettings();
        }
    }

    public static void Save(AppSettings settings)
    {
        try { File.WriteAllText(Path_, Toml.FromModel(settings)); }
        catch { /* 保存失敗は致命的でないので無視 */ }
    }
}
