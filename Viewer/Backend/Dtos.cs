using System.Text.Json;
using System.Text.Json.Serialization;

namespace Viewer.Backend;

/// <summary>
/// 共有 JSON 設定。フロントエンド（既存 file-list.js 等）が期待する snake_case
/// （is_dir / is_image / modified_at …）に合わせる。仕様 §0 のIPC流用方針。
/// </summary>
public static class Json
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}

/// <summary>get_files が返す 1 エントリ。フィールド名は frontend 互換（snake_case）。</summary>
public sealed class FileEntry
{
    public string Path { get; set; } = "";
    public string Name { get; set; } = "";
    public bool IsDir { get; set; }
    public bool IsImage { get; set; }
    public bool IsArchive { get; set; }
    /// <summary>更新日時（エポックからのミリ秒）。フォルダーは null。</summary>
    public long? ModifiedAt { get; set; }
}

/// <summary>get_folder_tree / ツリー用のフォルダー情報。</summary>
public sealed class FolderEntry
{
    public string Path { get; set; } = "";
    public string Name { get; set; } = "";
    public bool HasChildren { get; set; }
}

/// <summary>get_drives の 1 エントリ。</summary>
public sealed class DriveEntry
{
    public string Path { get; set; } = "";
    public string Name { get; set; } = "";
}

/// <summary>get_file_info の戻り値。</summary>
public sealed class BasicFileInfo
{
    public long Size { get; set; }
    public long ModifiedAt { get; set; }
    public bool IsDir { get; set; }
}

/// <summary>書庫内エントリ（仕様 §5）。path は書庫内の内部パス（'/' 区切りを '\' に正規化）。</summary>
public sealed class ArchiveEntry
{
    public string Path { get; set; } = "";   // 書庫内パス（inner path）
    public string Name { get; set; } = "";
    public bool IsDir { get; set; }
    public bool IsImage { get; set; }
    public bool IsArchive { get; set; }       // 入れ子書庫は当面 false
    public long Size { get; set; }
}

/// <summary>get_modifier_state の戻り値（仕様 §2.2）。</summary>
public sealed class ModifierState
{
    public bool Shift { get; set; }
    public bool Ctrl { get; set; }
    public bool Alt { get; set; }
}

/// <summary>load_shortcuts の戻り値（仕様 §8。当面は上書きなし＝既定）。</summary>
public sealed class ShortcutSettings
{
    public int Version { get; set; } = 1;
    public object[] Bindings { get; set; } = Array.Empty<object>();
}
