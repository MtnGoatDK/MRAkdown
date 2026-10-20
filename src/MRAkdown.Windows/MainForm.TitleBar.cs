using System.Runtime.InteropServices;

namespace MRAkdown;

/// <summary>
/// No separate title bar: the page's tab bar takes its place, as in Chrome or Windows Terminal (and as on Linux).
/// The window keeps its normal frame, so resizing, the shadow, rounded corners and snapping still work; only the
/// caption is given to the page. Empty parts of the tab bar are drag regions (CSS app-region, handled by WebView2:
/// drag to move, double-click to maximize, right-click for the window menu), and the page draws the window buttons.
/// </summary>
sealed partial class MainForm
{
    const int WM_NCCALCSIZE = 0x0083;
    const int HTTOP = 12, HTTOPLEFT = 13;

    // Read by app.js before it runs: which window buttons to draw, that dragging is native (app-region), and which
    // backdrops the window can have (see MainForm.Backdrop.cs).
    static string WindowControlsScript =>
        "window.hostWindowControls = { left: [], right: ['minimize', 'maximize', 'close'], nativeDrag: true };"
        + $"window.hostBackdrops = {(MicaSupported ? "['mica']" : "[]")};";

    // Width of the page's three window buttons (46 CSS px each, see .native-titlebar in app.css).
    const int WindowButtonsWidth = 3 * 46;

    bool _maximized;

    /// <summary>
    /// The page covers the whole client area, so resizing from the top edge needs a thin strip of our own over the
    /// top of the page (the other edges keep the normal, invisible resize borders). It stops before the window
    /// buttons, so they reach the top edge like real ones. Hidden while maximized.
    /// </summary>
    readonly ResizeStrip _topStrip = new();

    int TopStripHeight => LogicalToDeviceUnits(4);

    int TopStripWidth => Math.Max(0, ClientSize.Width - LogicalToDeviceUnits(WindowButtonsWidth));

    async Task InitTitleBarAsync(Microsoft.Web.WebView2.Core.CoreWebView2 core)
    {
        core.Settings.IsNonClientRegionSupportEnabled = true;
        await core.AddScriptToExecuteOnDocumentCreatedAsync(WindowControlsScript);
        _topStrip.BackColor = BackColor;
        Controls.Add(_topStrip);
        _topStrip.BringToFront();
        Resize += (_, _) => UpdateWindowState();
        DpiChanged += (_, _) => UpdateWindowState();
        UpdateWindowState();
    }

    /// <summary>Keeps the top resize strip and the page's maximize/restore button in step with the window.</summary>
    void UpdateWindowState()
    {
        if (!IsHandleCreated) return;
        _topStrip.Visible = !IsZoomed(Handle);
        _topStrip.Bounds = new Rectangle(0, 0, TopStripWidth, TopStripHeight);
        var maximized = WindowState == FormWindowState.Maximized;
        if (maximized == _maximized) return;
        _maximized = maximized;
        if (_pageReady) PostToPage(new { type = "windowState", maximized });
    }

    void ToggleMaximized() =>
        WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_NCCALCSIZE && m.WParam != IntPtr.Zero)
        {
            // Let Windows compute the normal frame, then give the caption back to the client area.
            var top = Marshal.PtrToStructure<RECT>(m.LParam).Top;
            base.WndProc(ref m);
            var rect = Marshal.PtrToStructure<RECT>(m.LParam);
            // A maximized window reaches past the screen edges by its frame thickness; keep that part hidden.
            rect.Top = top + (IsZoomed(Handle) ? FrameThickness() : 0);
            Marshal.StructureToPtr(rect, m.LParam, false);
            m.Result = IntPtr.Zero;
            return;
        }
        base.WndProc(ref m);
    }

    /// <summary>
    /// The top resize strip: shows the resize cursor, and pressing it starts a resize of the window from the top
    /// edge (or the top-left corner), as if the press had been on the window's own frame.
    /// </summary>
    sealed class ResizeStrip : Panel
    {
        int CornerWidth => LogicalToDeviceUnits(16);

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            Cursor = e.X < CornerWidth ? Cursors.SizeNWSE : Cursors.SizeNS;
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left || FindForm() is not { } form) return;
            ReleaseCapture();
            SendMessage(form.Handle, WM_NCLBUTTONDOWN, e.X < CornerWidth ? HTTOPLEFT : HTTOP, IntPtr.Zero);
        }
    }

    const int WM_NCLBUTTONDOWN = 0x00A1;

    [DllImport("user32.dll")]
    static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    static extern IntPtr SendMessage(IntPtr hwnd, int msg, int wParam, IntPtr lParam);

    int FrameThickness() =>
        GetSystemMetricsForDpi(33 /* SM_CYFRAME */, (uint)DeviceDpi) + GetSystemMetricsForDpi(92 /* SM_CXPADDEDBORDER */, (uint)DeviceDpi);

    /// <summary>Makes Windows recalculate the frame, so the caption is removed as soon as the window exists.</summary>
    void ApplyFrame() =>
        SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0004 | 0x0020 /* NOSIZE|NOMOVE|NOZORDER|FRAMECHANGED */);

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")]
    static extern bool IsZoomed(IntPtr hwnd);

    [DllImport("user32.dll")]
    static extern int GetSystemMetricsForDpi(int index, uint dpi);

    [DllImport("user32.dll")]
    static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
