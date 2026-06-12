using System.Windows;

namespace Viewer;

/// <summary>
/// 設定ウィンドウ（ツール → 設定）。中身は WebView2（settings.html）。左カテゴリ＋右パネル。
/// 1 個のみ運用（MainWindow が単一インスタンスを管理）。
/// </summary>
public partial class SettingsWindow : Window
{
    public SettingsWindow()
    {
        InitializeComponent();
    }
}
