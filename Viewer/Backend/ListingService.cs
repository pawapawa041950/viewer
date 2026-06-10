using System.IO;

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

    public static List<FileEntry> GetFiles(string path)
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
                folders.Add(new FileEntry
                {
                    Path = e.FullName,
                    Name = e.Name,
                    IsDir = true,
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

        folders.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase));
        files.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase));

        folders.AddRange(files);
        return folders;
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

    private static bool ShouldSkip(FileSystemInfo e)
    {
        // ドット始まり（隠し慣習）はスキップ。仕様 §1.2。
        if (e.Name.StartsWith('.')) return true;
        return false;
    }

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
