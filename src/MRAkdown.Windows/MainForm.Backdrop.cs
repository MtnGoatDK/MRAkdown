using System.Runtime.InteropServices;

namespace MRAkdown;

/// <summary>
/// The window's look as the page asks for it ("appearance" messages): a dark or light frame for its theme, and on
/// Windows 11 the translucent Mica backdrop behind the sidebar and tab bar (the page makes those parts transparent).
/// </summary>
sealed partial class MainForm
{
    // Windows 11 22H2 (build 22621) and newer can give a window a system backdrop (DWMWA_SYSTEMBACKDROP_TYPE)
    static bool MicaSupported => Environment.OSVersion.Version.Build >= 22621;

    bool _dark = IsDarkMode();
    bool _mica;

    /// <summary>Applies the page's theme (dark) and backdrop choice (mica) to the window.</summary>
    void SetAppearance(bool dark, bool mica)
    {
        mica &= MicaSupported;
        if (dark == _dark && mica == _mica) return;
        _dark = dark;
        _mica = mica;
        ApplyAppearance();
    }

    void ApplyAppearance()
    {
        if (!IsHandleCreated) return;
        var on = _dark ? 1 : 0;
        DwmSetWindowAttribute(Handle, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, ref on, sizeof(int));
        if (MicaSupported)
        {
            var backdrop = _mica ? 2 /* DWMSBT_MAINWINDOW */ : 1 /* DWMSBT_NONE */;
            DwmSetWindowAttribute(Handle, 38 /* DWMWA_SYSTEMBACKDROP_TYPE */, ref backdrop, sizeof(int));
            // The backdrop shows through the client area where the frame is extended into it and nothing opaque is
            // drawn: the form paints black (transparent there) and the page's background is transparent. Extended
            // from the left over the whole width, not from the top: a frame extended over the top makes Windows
            // draw its own caption buttons over the page's.
            var margins = _mica ? new MARGINS { Left = short.MaxValue } : default;
            DwmExtendFrameIntoClientArea(Handle, ref margins);
        }
        // Matches the tab bar (--bg-side in app.css) where it shows: the thin resize strip above the page
        BackColor = _mica ? Color.Black : _dark ? Color.FromArgb(38, 38, 38) : Color.FromArgb(246, 246, 246);
        _topStrip.BackColor = BackColor;
        _web.DefaultBackgroundColor = _mica ? Color.Transparent : _dark ? Color.FromArgb(30, 30, 30) : Color.White;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MARGINS { public int Left, Right, Top, Bottom; }

    [DllImport("dwmapi.dll")]
    static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref MARGINS margins);
}
