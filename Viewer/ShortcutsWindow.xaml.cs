using System.Windows;

namespace Viewer;

/// <summary>
/// ショートカット編集ウィンドウ（仕様 §8）。中身は WebView2（shortcuts.html）。
/// 1 個のみ運用（MainWindow が単一インスタンスを管理）。
/// </summary>
public partial class ShortcutsWindow : Window
{
    public ShortcutsWindow()
    {
        InitializeComponent();
    }
}
