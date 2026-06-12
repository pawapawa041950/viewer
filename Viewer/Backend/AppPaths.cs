using System.IO;

namespace Viewer.Backend;

/// <summary>
/// 永続データ（settings.toml / shortcuts.json / WebView2Data）の置き場所（仕様 §9：ポータブル）。
/// 単一 exe（自己展開）では <see cref="System.AppContext.BaseDirectory"/> が一時展開先を指すため、
/// 設定類が exe 隣に残らない。実際の exe のフォルダー（<see cref="System.Environment.ProcessPath"/>）を使う。
/// 非単一 exe では両者は同じ（= exe フォルダー）。
/// </summary>
public static class AppPaths
{
    public static string ExeDir { get; } =
        Path.GetDirectoryName(Environment.ProcessPath) ?? AppContext.BaseDirectory;

    public static string Combine(string name) => Path.Combine(ExeDir, name);
}
