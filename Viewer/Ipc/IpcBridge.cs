using System.Text.Json;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Viewer.Backend;

namespace Viewer.Ipc;

/// <summary>
/// WebView2 ↔ ホスト間の疎結合 IPC（仕様 §0 / A.3）。
///
/// JS 側には Tauri 互換のシム（<c>window.invoke</c> / <c>window.__TAURI__.core.invoke</c> /
/// <c>window.__TAURI__.event.listen</c>）を注入する。これにより既存フロント
/// （file-list.js / shortcut-dispatch.js 等）をほぼ無改変で流用できる。
///
/// プロトコル（JSON, postMessage）:
///   JS→Host : { type:"invoke", id, cmd, args }
///   Host→JS : { type:"response", id, ok, result|error }
///   Host→JS : { type:"event", name, payload }
/// </summary>
public sealed class IpcBridge
{
    private readonly CoreWebView2 _core;
    private readonly Dispatcher _dispatcher;
    private readonly Dictionary<string, Func<JsonElement, Task<object?>>> _handlers = new();

    public IpcBridge(CoreWebView2 core, Dispatcher dispatcher)
    {
        _core = core;
        _dispatcher = dispatcher;
        _core.WebMessageReceived += OnWebMessageReceived;
    }

    /// <summary>コマンドを登録。ハンドラは args(JsonElement) を受け取り結果オブジェクトを返す。</summary>
    public void Register(string cmd, Func<JsonElement, Task<object?>> handler) => _handlers[cmd] = handler;

    /// <summary>同期ハンドラ用の簡易登録。</summary>
    public void Register(string cmd, Func<JsonElement, object?> handler)
        => _handlers[cmd] = args => Task.FromResult(handler(args));

    /// <summary>ホスト→JS のイベント送出（Tauri の emit 相当）。</summary>
    public void EmitEvent(string name, object? payload)
    {
        void Send()
        {
            var msg = JsonSerializer.Serialize(new EventMessage(name, payload), Json.Options);
            _core.PostWebMessageAsJson(msg);
        }
        if (_dispatcher.CheckAccess()) Send();
        else _dispatcher.BeginInvoke(Send);
    }

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string raw;
        try { raw = e.WebMessageAsJson; }
        catch { return; }

        int id = 0;
        try
        {
            using var doc = JsonDocument.Parse(raw);
            var root = doc.RootElement;
            if (!root.TryGetProperty("type", out var t) || t.GetString() != "invoke") return;

            id = root.TryGetProperty("id", out var idEl) ? idEl.GetInt32() : 0;
            var cmd = root.TryGetProperty("cmd", out var cmdEl) ? cmdEl.GetString() ?? "" : "";
            var args = root.TryGetProperty("args", out var argsEl) ? argsEl.Clone() : default;

            if (!_handlers.TryGetValue(cmd, out var handler))
            {
                PostResponse(id, false, null, $"unknown command: {cmd}");
                return;
            }

            object? result = await handler(args).ConfigureAwait(true);
            PostResponse(id, true, result, null);
        }
        catch (Exception ex)
        {
            PostResponse(id, false, null, ex.Message);
        }
    }

    private void PostResponse(int id, bool ok, object? result, string? error)
    {
        void Send()
        {
            var msg = JsonSerializer.Serialize(new ResponseMessage(id, ok, result, error), Json.Options);
            _core.PostWebMessageAsJson(msg);
        }
        if (_dispatcher.CheckAccess()) Send();
        else _dispatcher.BeginInvoke(Send);
    }

    // ---- wire types ----
    private sealed record ResponseMessage(int Id, bool Ok, object? Result, string? Error)
    {
        public string Type => "response";
    }

    private sealed record EventMessage(string Name, object? Payload)
    {
        public string Type => "event";
    }

    /// <summary>各 WebView2 に注入する Tauri 互換シム（ドキュメント生成時に実行）。</summary>
    public const string BootstrapScript = """
    (function () {
      'use strict';
      const pending = new Map();
      let seq = 0;
      const listeners = new Map(); // name -> Set<fn>

      function onMessage(ev) {
        const msg = ev.data;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'response') {
          const p = pending.get(msg.id);
          if (!p) return;
          pending.delete(msg.id);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(new Error(msg.error || 'invoke failed'));
        } else if (msg.type === 'event') {
          const set = listeners.get(msg.name);
          if (set) for (const fn of set) {
            try { fn({ event: msg.name, payload: msg.payload }); } catch (e) { console.error(e); }
          }
        }
      }
      window.chrome.webview.addEventListener('message', onMessage);

      function invoke(cmd, args) {
        return new Promise((resolve, reject) => {
          const id = ++seq;
          pending.set(id, { resolve, reject });
          window.chrome.webview.postMessage({ type: 'invoke', id, cmd, args: args || {} });
        });
      }
      async function listen(name, cb) {
        let set = listeners.get(name);
        if (!set) { set = new Set(); listeners.set(name, set); }
        set.add(cb);
        return () => set.delete(cb);
      }

      // Tauri 互換のグローバルを用意（既存フロント流用のため）
      window.invoke = invoke;
      window.__TAURI__ = {
        core: { invoke },
        event: { listen, emit: () => {} },
      };
    })();
    """;
}
