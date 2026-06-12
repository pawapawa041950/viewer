using System.IO;
using System.Runtime.InteropServices;

namespace Viewer.Backend;

/// <summary>
/// ディレクトリ列挙（仕様 §1.2 / §1.4）。現行 Rust listing.rs と同等:
/// フォルダー先頭・大文字小文字無視ソート・ドット始まりはスキップ。
/// </summary>
public static class ListingService
{
    public static List<DriveEntry> GetDrives()
    {
        var list = new List<DriveEntry>();
        foreach (var d in DriveInfo.GetDrives())
        {
            try
            {
                var root = d.RootDirectory.FullName; // "C:\"
                var label = d.IsReady && !string.IsNullOrEmpty(d.VolumeLabel)
                    ? $"{d.VolumeLabel} ({d.Name.TrimEnd('\\')})"
                    : d.Name.TrimEnd('\\');
                list.Add(new DriveEntry { Path = root, Name = label });
            }
            catch { /* 準備できていないドライブはスキップ */ }
        }
        return list;
    }

    public static List<FolderEntry> GetFolderTree(string path)
    {
        var result = new List<FolderEntry>();
        DirectoryInfo[] dirs;
        try { dirs = new DirectoryInfo(path).GetDirectories(); }
        catch { return result; }

        foreach (var dir in dirs)
        {
            if (ShouldSkip(dir)) continue;
            result.Add(new FolderEntry
            {
                Path = dir.FullName,
                Name = dir.Name,
                HasChildren = HasSubdirectory(dir),
            });
        }
        result.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase));
        return result;
    }

    public static List<FileEntry> GetFiles(string path, string sortMode = "name_asc")
    {
        var folders = new List<FileEntry>();
        var files = new List<FileEntry>();

        DirectoryInfo dirInfo;
        try { dirInfo = new DirectoryInfo(path); }
        catch { return new List<FileEntry>(); }

        FileSystemInfo[] entries;
        try { entries = dirInfo.GetFileSystemInfos(); }
        catch { return new List<FileEntry>(); }

        foreach (var e in entries)
        {
            if (ShouldSkip(e)) continue;

            if (e is DirectoryInfo)
            {
                long? dmtime = null;
                try { dmtime = new DateTimeOffset(e.LastWriteTimeUtc, TimeSpan.Zero).ToUnixTimeMilliseconds(); }
                catch { }
                folders.Add(new FileEntry
                {
                    Path = e.FullName,
                    Name = DisplayNameOf(e),
                    IsDir = true,
                    ModifiedAt = dmtime,
                });
            }
            else
            {
                long? mtime = null;
                try { mtime = new DateTimeOffset(e.LastWriteTimeUtc, TimeSpan.Zero).ToUnixTimeMilliseconds(); }
                catch { }
                files.Add(new FileEntry
                {
                    Path = e.FullName,
                    Name = e.Name,
                    IsDir = false,
                    IsImage = FileTypes.IsImage(e.Name),
                    IsArchive = FileTypes.IsArchive(e.Name),
                    ModifiedAt = mtime,
                });
            }
        }

        // フォルダーは先頭・ファイルは後半という構成は維持しつつ、両方ともソート設定に従う（仕様 §1.4）。
        int NameCmp(FileEntry a, FileEntry b) => string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
        Comparison<FileEntry> cmp = sortMode switch
        {
            "name_desc" => (a, b) => -NameCmp(a, b),
            "date_asc" => (a, b) => Comparer<long>.Default.Compare(a.ModifiedAt ?? 0, b.ModifiedAt ?? 0) is var c && c != 0 ? c : NameCmp(a, b),
            "date_desc" => (a, b) => Comparer<long>.Default.Compare(b.ModifiedAt ?? 0, a.ModifiedAt ?? 0) is var c && c != 0 ? c : NameCmp(a, b),
            _ => NameCmp, // name_asc
        };
        folders.Sort(cmp);
        files.Sort(cmp);

        folders.AddRange(files);
        return folders;
    }

    /// <summary>フォルダー直下の「1 枚目の画像」のフルパス（名前昇順で先頭）。無ければ null。
    /// サムネイル表示用。隠し/ドット始まりは除外（一覧と同じ ShouldSkip）。</summary>
    public static string? FirstImageEntry(string folder)
    {
        try
        {
            if (!Directory.Exists(folder)) return null;
            string? bestPath = null, bestName = null;
            foreach (var f in new DirectoryInfo(folder).EnumerateFiles())
            {
                if (ShouldSkip(f) || !FileTypes.IsImage(f.Name)) continue;
                if (bestName == null || string.Compare(f.Name, bestName, StringComparison.OrdinalIgnoreCase) < 0)
                {
                    bestName = f.Name;
                    bestPath = f.FullName;
                }
            }
            return bestPath;
        }
        catch
        {
            return null;
        }
    }

    public static BasicFileInfo GetFileInfo(string path)
    {
        var fi = new FileInfo(path);
        bool isDir = Directory.Exists(path);
        long size = 0;
        long mtime = 0;
        try
        {
            if (isDir)
            {
                mtime = new DateTimeOffset(new DirectoryInfo(path).LastWriteTimeUtc, TimeSpan.Zero).ToUnixTimeMilliseconds();
            }
            else
            {
                size = fi.Length;
                mtime = new DateTimeOffset(fi.LastWriteTimeUtc, TimeSpan.Zero).ToUnixTimeMilliseconds();
            }
        }
        catch { }
        return new BasicFileInfo { Size = size, ModifiedAt = mtime, IsDir = isDir };
    }

    /// <summary>隠しファイル・フォルダーを表示するか（設定ウィンドウ「全般」から切替）。</summary>
    public static bool ShowHidden { get; set; }

    private static bool ShouldSkip(FileSystemInfo e)
    {
        // ドット始まり（隠し慣習）はスキップ。仕様 §1.2。
        if (e.Name.StartsWith('.')) return true;
        // 隠し属性はエクスプローラー既定と同様に非表示（ツリーのシェル列挙とも一致）。
        // ※ Hidden+System の「保護されたOSファイル」も Hidden により除外される。
        //   設定「隠しファイルを表示」がONなら表示する。
        if (!ShowHidden)
        {
            try { if ((e.Attributes & FileAttributes.Hidden) != 0) return true; }
            catch { /* 属性取得不可はスキップ扱いにしない */ }
        }
        return false;
    }

    // フォルダーの表示名。ReadOnly / System 属性が付くフォルダーは desktop.ini による
    // 表示名上書き（例: 実名 "nekone" → "キャプチャ"）があり得るため、シェル表示名を解決して
    // エクスプローラー／ツリーと一致させる。通常フォルダーは属性チェックで素通り＝コストほぼ無し。
    private static string DisplayNameOf(FileSystemInfo e)
    {
        try
        {
            if ((e.Attributes & (FileAttributes.ReadOnly | FileAttributes.System)) != 0)
            {
                var shellName = ShellDisplayName(e.FullName);
                if (!string.IsNullOrEmpty(shellName)) return shellName!;
            }
        }
        catch { }
        return e.Name;
    }

    private static string? ShellDisplayName(string path)
    {
        try
        {
            var info = new SHFILEINFO();
            var r = SHGetFileInfo(path, 0, ref info, (uint)Marshal.SizeOf<SHFILEINFO>(), SHGFI_DISPLAYNAME);
            if (r == IntPtr.Zero) return null;
            return string.IsNullOrEmpty(info.szDisplayName) ? null : info.szDisplayName;
        }
        catch { return null; }
    }

    private const uint SHGFI_DISPLAYNAME = 0x000000200;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SHFILEINFO
    {
        public IntPtr hIcon;
        public int iIcon;
        public uint dwAttributes;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szDisplayName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string szTypeName;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SHGetFileInfo(
        string pszPath, uint dwFileAttributes, ref SHFILEINFO psfi, uint cbSizeFileInfo, uint uFlags);

    private static bool HasSubdirectory(DirectoryInfo dir)
    {
        try
        {
            foreach (var sub in dir.EnumerateDirectories())
            {
                if (!ShouldSkip(sub)) return true;
            }
        }
        catch { }
        return false;
    }
}
