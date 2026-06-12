using System.Buffers.Binary;
using System.Text;
using PeterO.Cbor;

namespace Viewer.Backend;

/// <summary>
/// C2PA 来歴情報の抽出（仕様 §6.1）。ChatGPT/OpenAI 生成 PNG は `caBX` チャンクに
/// JUMBF(ISO BMFF 風)コンテナを持ち、その中の CBOR に claim/actions が入る。
/// 元 Rust 実装（details.rs の extract_c2pa_from_png_bytes 系）を移植。CBOR は PeterO.Cbor。
///
/// 注意: 現在リポジトリに C2PA サンプル画像が無いため未検証。例外は内部で握り潰し、
/// 通常のメタデータ抽出を阻害しない。
/// </summary>
public static class C2paExtractor
{
    public sealed class Result
    {
        public string? ClaimGenerator;
        public List<string> Actions = new();
        public List<string> SoftwareAgents = new();
        public List<string> DigitalSourceTypes = new();
        public List<string> Whens = new();
        public bool HasAny => ClaimGenerator != null || Actions.Count > 0 || SoftwareAgents.Count > 0
                              || DigitalSourceTypes.Count > 0 || Whens.Count > 0;
    }

    /// <summary>PNG バイト列から C2PA を抽出。無ければ null。</summary>
    public static Result? FromPng(byte[] data)
    {
        try
        {
            if (data.Length < 8) return null;
            int offset = 8;
            while (offset + 12 <= data.Length)
            {
                int length = BinaryPrimitives.ReadInt32BigEndian(data.AsSpan(offset, 4));
                if (length < 0) break;
                var ctype = Encoding.ASCII.GetString(data, offset + 4, 4);
                long end = (long)offset + 12 + length;
                if (end > data.Length) break;
                if (ctype == "caBX")
                {
                    var r = new Result();
                    WalkJumbf(data.AsSpan(offset + 8, length), r);
                    return r.HasAny ? r : null;
                }
                if (ctype == "IEND") break;
                offset = (int)end;
            }
        }
        catch { /* 破損/想定外は無視 */ }
        return null;
    }

    private static void WalkJumbf(ReadOnlySpan<byte> buf, Result r)
    {
        int p = 0;
        while (p + 8 <= buf.Length)
        {
            int length = BinaryPrimitives.ReadInt32BigEndian(buf.Slice(p, 4));
            var typ = Encoding.ASCII.GetString(buf.Slice(p + 4, 4));
            int boxLen = length == 0 ? buf.Length - p : length;
            if (boxLen < 8 || p + boxLen > buf.Length) break;
            var payload = buf.Slice(p + 8, boxLen - 8);

            if (typ == "jumb")
            {
                string? label = null;
                int q = 0;
                while (q + 8 <= payload.Length)
                {
                    int l2 = BinaryPrimitives.ReadInt32BigEndian(payload.Slice(q, 4));
                    var t2 = Encoding.ASCII.GetString(payload.Slice(q + 4, 4));
                    int bl2 = l2 == 0 ? payload.Length - q : l2;
                    if (bl2 < 8 || q + bl2 > payload.Length) break;
                    var p2 = payload.Slice(q + 8, bl2 - 8);

                    if (t2 == "jumd")
                    {
                        // [type_uuid(16)][toggles(1)][label(null-terminated, optional)]
                        if (p2.Length >= 17)
                        {
                            var rest = p2.Slice(17);
                            int nul = rest.IndexOf((byte)0);
                            if (nul < 0) nul = rest.Length;
                            label = Encoding.UTF8.GetString(rest.Slice(0, nul));
                        }
                    }
                    else if (t2 == "cbor")
                    {
                        if (label != null) HandleCbor(label, p2.ToArray(), r);
                    }
                    else if (t2 == "jumb")
                    {
                        WalkJumbf(payload.Slice(q, bl2), r);
                    }
                    q += bl2;
                }
            }
            p += boxLen;
        }
    }

    private static void HandleCbor(string label, byte[] payload, Result r)
    {
        CBORObject val;
        try { val = CBORObject.DecodeFromBytes(payload); }
        catch { return; }

        if (label is "c2pa.claim.v2" or "c2pa.claim")
        {
            var info = Lookup(val, "claim_generator_info");
            if (info != null)
            {
                var n = AsText(Lookup(info, "name"));
                if (n != null) r.ClaimGenerator = n;
                else if (info.Type == CBORType.Array && info.Count > 0)
                    r.ClaimGenerator = AsText(Lookup(info[0], "name"));
            }
        }
        else if (label is "c2pa.actions.v2" or "c2pa.actions")
        {
            var arr = Lookup(val, "actions");
            if (arr != null && arr.Type == CBORType.Array)
            {
                foreach (var a in arr.Values)
                {
                    var act = AsText(Lookup(a, "action"));
                    if (act != null) PushUnique(r.Actions, act);

                    var sa = Lookup(a, "softwareAgent");
                    if (sa != null)
                    {
                        var n = AsText(Lookup(sa, "name")) ?? AsText(sa);
                        if (n != null) PushUnique(r.SoftwareAgents, n);
                    }

                    var dst = AsText(Lookup(a, "digitalSourceType"));
                    if (dst != null) PushUnique(r.DigitalSourceTypes, ShortenIptcUrl(dst));

                    var w = AsTextOrTag(Lookup(a, "when"));
                    if (w != null) PushUnique(r.Whens, w);
                }
            }
        }
    }

    private static CBORObject? Lookup(CBORObject? v, string key)
    {
        if (v == null || v.Type != CBORType.Map) return null;
        var k = CBORObject.FromObject(key);
        return v.ContainsKey(k) ? v[k] : null;
    }

    private static string? AsText(CBORObject? v)
        => v != null && v.Type == CBORType.TextString ? v.AsString() : null;

    private static string? AsTextOrTag(CBORObject? v)
    {
        if (v == null) return null;
        if (v.Type == CBORType.TextString) return v.AsString();
        if (v.IsTagged) return AsText(v.Untag());
        return null;
    }

    private static string ShortenIptcUrl(string url)
    {
        int i = url.LastIndexOf('/');
        return i >= 0 && i < url.Length - 1 ? url[(i + 1)..] : url;
    }

    private static void PushUnique(List<string> list, string item)
    {
        if (!list.Contains(item)) list.Add(item);
    }
}
