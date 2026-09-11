using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;

namespace Viewer;

/// <summary>
/// アプリのエントリポイント。単一インスタンス化と、メディアファイル関連付け起動
/// （コマンドライン引数のファイル/フォルダ/書庫を開く）を担う。
///
/// <para>2 個目以降の起動は Mutex で検出し、名前付きパイプで先行インスタンスへ引数を転送して
/// 自身は終了する。先行インスタンスはパイプで受けたパスを開き、ウィンドウを前面化する。</para>
/// </summary>
public partial class App : Application
{
    // ユーザー単位で一意にする（別ユーザーのセッションとは干渉しない）。
    private static readonly string InstanceKey = "Viewer.SingleInstance." + Environment.UserName;
    private static readonly string MutexName = InstanceKey + ".Mutex";
    private static readonly string PipeName = InstanceKey + ".Pipe";

    private Mutex? _mutex;
    private CancellationTokenSource? _pipeCts;

    /// <summary>起動時にファイルが渡された場合のパス（cold start 用）。MainWindow が消費する。</summary>
    public string? PendingOpenPath { get; private set; }

    protected override void OnStartup(StartupEventArgs e)
    {
        var arg = e.Args.Length > 0 ? e.Args[0] : null;

        _mutex = new Mutex(initiallyOwned: true, MutexName, out bool createdNew);
        if (!createdNew)
        {
            // 既に起動中：引数を先行インスタンスへ送って自身は終了する。
            TrySendToExisting(arg ?? "");
            Shutdown();
            return;
        }

        PendingOpenPath = arg;
        base.OnStartup(e);          // StartupUri で MainWindow を生成
        StartPipeServer();          // 2 個目以降からの引数を待ち受ける
    }

    protected override void OnExit(ExitEventArgs e)
    {
        try { _pipeCts?.Cancel(); } catch { }
        try { _mutex?.ReleaseMutex(); } catch { }
        _mutex?.Dispose();
        base.OnExit(e);
    }

    // ---- 先行インスタンスへ引数を送る（2 個目の起動側） ----
    private static void TrySendToExisting(string path)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out);
            client.Connect(2000); // 2 秒でタイムアウト
            var bytes = Encoding.UTF8.GetBytes(path);
            client.Write(bytes, 0, bytes.Length);
            client.Flush();
        }
        catch
        {
            // 送信できなくても自身は終了する（先行インスタンスが応答しない等）。
        }
    }

    // ---- 先行インスタンス側：パイプで引数を受け取り続ける ----
    private void StartPipeServer()
    {
        _pipeCts = new CancellationTokenSource();
        var token = _pipeCts.Token;
        _ = Task.Run(async () =>
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    using var server = new NamedPipeServerStream(
                        PipeName, PipeDirection.In, 1,
                        PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
                    await server.WaitForConnectionAsync(token).ConfigureAwait(false);

                    using var ms = new MemoryStream();
                    var buf = new byte[4096];
                    int n;
                    while ((n = await server.ReadAsync(buf, 0, buf.Length, token).ConfigureAwait(false)) > 0)
                        ms.Write(buf, 0, n);
                    var path = Encoding.UTF8.GetString(ms.ToArray());

                    // UI スレッドで開く＋前面化。
                    await Dispatcher.InvokeAsync(() =>
                    {
                        if (MainWindow is MainWindow mw) _ = mw.HandleExternalOpenAsync(path);
                    });
                }
                catch (OperationCanceledException) { break; }
                catch { /* 1 接続の失敗は無視して待ち受けを継続 */ }
            }
        }, token);
    }
}
