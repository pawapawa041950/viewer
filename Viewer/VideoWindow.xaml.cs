using System.Windows;

namespace Viewer;

/// <summary>
/// 動画ウィンドウ（仕様 §4 の画像ウィンドウを踏襲した簡易版・単一インスタンス）。
/// 中身は WebView2（video.html）。&lt;video&gt; 標準コントロールの全画面ボタンに
/// 追随するため、ImageWindow と同じフルスクリーン切替を持つ。
/// </summary>
public partial class VideoWindow : Window
{
    private WindowStyle _prevStyle;
    private WindowState _prevState;
    private ResizeMode _prevResize;
    private bool _isFullscreen;

    /// <summary>全画面表示中か。全画面中に閉じたときはサイズ設定を保存しないために使う。</summary>
    public bool IsFullscreen => _isFullscreen;

    public VideoWindow()
    {
        InitializeComponent();
        // アクティブになるたび WebView2 へキーボードフォーカスを移す（ImageWindow と同じ対策）。
        Activated += (_, _) => View.Focus();
    }

    /// <summary>フルスクリーン切替（HTML 全画面要素への追随用）。</summary>
    public void SetFullscreen(bool on)
    {
        if (on == _isFullscreen) return;

        if (on)
        {
            _prevStyle = WindowStyle;
            _prevState = WindowState;
            _prevResize = ResizeMode;

            // 一旦 Normal にしないと Maximized+None が効かないことがある。
            WindowState = WindowState.Normal;
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
            WindowState = WindowState.Maximized;
            _isFullscreen = true;
        }
        else
        {
            WindowStyle = _prevStyle;
            ResizeMode = _prevResize;
            WindowState = _prevState;
            _isFullscreen = false;
        }
    }
}
