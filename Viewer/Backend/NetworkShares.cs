using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

namespace Viewer.Backend;

/// <summary>
/// UNC のサーバー直下（<c>\\server</c>）の扱い。サーバー直下は Directory.Exists が false になり
/// 通常のファイル列挙ができないため、NetShareEnum で共有一覧を取得して「フォルダー」として見せる。
/// </summary>
public static class NetworkShares
{
    // "\\server" / "\\server\" / "//server" のみ（共有名以下が付くものは通常パス扱い）。
    private static readonly Regex ServerRootRe = new(@"^[\\/]{2}([^\\/]+)[\\/]?$", RegexOptions.Compiled);

    /// <summary>UNC のサーバー直下（共有名なし）か。</summary>
    public static bool IsServerRoot(string? path)
        => !string.IsNullOrEmpty(path) && ServerRootRe.IsMatch(path);

    /// <summary>サーバー名（"\\server" → "server"）。サーバー直下でなければ null。</summary>
    public static string? ServerOf(string? path)
    {
        if (string.IsNullOrEmpty(path)) return null;
        var m = ServerRootRe.Match(path);
        return m.Success ? m.Groups[1].Value : null;
    }

    /// <summary>"\\server" 形式に正規化（末尾区切りなし・区切りはバックスラッシュ）。</summary>
    public static string Normalize(string path) => @"\\" + (ServerOf(path) ?? path.Trim('\\', '/'));

    /// <summary>
    /// サーバーのディスク共有名を列挙する（IPC$ / ADMIN$ 等の特殊共有と末尾 $ の隠し共有は除外）。
    /// 到達できない・権限がない場合は空。
    /// </summary>
    public static List<string> EnumerateShares(string server)
    {
        var result = new List<string>();
        if (string.IsNullOrEmpty(server)) return result;
        // レベル 1（種別付き）→ 失敗ならレベル 0（名前のみ）の順に試す。
        if (!TryEnum(server, 1, result)) TryEnum(server, 0, result);
        result.Sort(StringComparer.OrdinalIgnoreCase);
        return result;
    }

    private static bool TryEnum(string server, int level, List<string> result)
    {
        IntPtr buf = IntPtr.Zero;
        uint resume = 0;
        try
        {
            var rc = NetShareEnum(@"\\" + server, level, out buf, MAX_PREFERRED_LENGTH,
                                  out uint read, out _, ref resume);
            if (rc != NERR_Success && rc != ERROR_MORE_DATA) return false;
            if (level == 1)
            {
                var size = Marshal.SizeOf<SHARE_INFO_1>();
                for (var i = 0; i < read; i++)
                {
                    var info = Marshal.PtrToStructure<SHARE_INFO_1>(buf + i * size);
                    if ((info.shi1_type & STYPE_MASK) != STYPE_DISKTREE) continue;   // ディスク共有のみ
                    if ((info.shi1_type & STYPE_SPECIAL) != 0) continue;            // IPC$ / ADMIN$ / C$ 等
                    if (string.IsNullOrEmpty(info.shi1_netname) || info.shi1_netname.EndsWith('$')) continue;
                    result.Add(info.shi1_netname);
                }
            }
            else
            {
                var size = Marshal.SizeOf<SHARE_INFO_0>();
                for (var i = 0; i < read; i++)
                {
                    var info = Marshal.PtrToStructure<SHARE_INFO_0>(buf + i * size);
                    if (string.IsNullOrEmpty(info.shi0_netname) || info.shi0_netname.EndsWith('$')) continue;
                    result.Add(info.shi0_netname);
                }
            }
            return true;
        }
        catch
        {
            return false;
        }
        finally
        {
            if (buf != IntPtr.Zero) NetApiBufferFree(buf);
        }
    }

    private const int NERR_Success = 0;
    private const int ERROR_MORE_DATA = 234;
    private const uint MAX_PREFERRED_LENGTH = 0xFFFFFFFF;
    private const uint STYPE_DISKTREE = 0;
    private const uint STYPE_MASK = 0x000000FF;
    private const uint STYPE_SPECIAL = 0x80000000;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SHARE_INFO_0
    {
        public string shi0_netname;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SHARE_INFO_1
    {
        public string shi1_netname;
        public uint shi1_type;
        public string shi1_remark;
    }

    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
    private static extern int NetShareEnum(
        string serverName, int level, out IntPtr bufPtr, uint prefMaxLen,
        out uint entriesRead, out uint totalEntries, ref uint resumeHandle);

    [DllImport("netapi32.dll")]
    private static extern int NetApiBufferFree(IntPtr buffer);
}
