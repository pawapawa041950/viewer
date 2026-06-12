using System.Windows;

namespace Viewer;

/// <summary>
/// イメージウィンドウ（仕様 §4）。当面は 1 個のみ運用（D.7）。
/// 中身は WebView2（viewer.html）で、表示・レイアウト・操作はフロント側が担う。
/// </summary>
public partial class ImageWindow : Window
{
    private WindowStyle _prevStyle;
    private WindowState _prevState;
    private ResizeMode _prevResize;
    private bool _isFullscreen;

    /// <summary>全画面表示中か。全画面中に閉じたときはサイズ設定を保存しないために使う。</summary>
    public bool IsFullscreen => _isFullscreen;

    public ImageWindow()
    {
        InitializeComponent();
        // ウィンドウがアクティブになるたび WebView2 のWeb内容へキーボードフォーカスを移す
        // （クリックしないとショートカットが効かない問題の対策。alt+tab 復帰時も含む）。
        Activated += (_, _) => View.Focus();
    }

    /// <summary>フルスクリーン切替（装飾の出し入れ込み。仕様 §4.3）。</summary>
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
