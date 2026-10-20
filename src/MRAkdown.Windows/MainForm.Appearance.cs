namespace MRAkdown;

/// <summary>
/// The window's look as the page asks for it ("appearance" messages): a dark or light frame and background for the
/// app's theme (the Theme setting, or the system's).
/// </summary>
sealed partial class MainForm
{
    bool _dark = IsDarkMode();

    void SetAppearance(bool dark)
    {
        if (dark == _dark) return;
        _dark = dark;
        ApplyAppearance();
    }

    void ApplyAppearance()
    {
        if (!IsHandleCreated) return;
        var on = _dark ? 1 : 0;
        DwmSetWindowAttribute(Handle, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, ref on, sizeof(int));
        // Matches the tab bar (--bg-side in app.css) where it shows: the thin resize strip above the page
        BackColor = _dark ? Color.FromArgb(38, 38, 38) : Color.FromArgb(246, 246, 246);
        _topStrip.BackColor = BackColor;
        _web.DefaultBackgroundColor = _dark ? Color.FromArgb(30, 30, 30) : Color.White;
    }
}
