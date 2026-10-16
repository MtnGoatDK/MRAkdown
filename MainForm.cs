using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Web;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace MRAkdown;

/// <summary>
/// One window: a WebView2 page with tabs. Notes are served from <see cref="Roots"/> under
/// /f/{root id}/..., so tabs can show notes from different folders.
/// </summary>
sealed class MainForm : Form
{
    const string Origin = "https://notes.local";

    // All windows share one browser environment, so extra windows start quickly.
    static Task<CoreWebView2Environment>? s_environment;

    readonly MRAkdownApp _app;
    readonly WebView2 _web = new() { Dock = DockStyle.Fill };
    readonly NoteIndex? _startRoot;
    readonly string? _startNote;
    // Messages for the page that arrive before it has loaded; sent once it reports "ready".
    readonly List<object> _pendingMessages = [];
    bool _pageReady;
    bool _hasUnsavedEdits;
    bool _closeRequested;

    public MainForm(MRAkdownApp app, NoteIndex? root, string? note)
    {
        _app = app;
        _startRoot = root;
        _startNote = note;
        Text = "MRAkdown";
        Size = new Size(1200, 800);
        StartPosition = FormStartPosition.CenterScreen;
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        BackColor = _web.DefaultBackgroundColor = IsDarkMode() ? Color.FromArgb(30, 30, 30) : Color.White;
        Controls.Add(_web);

        Roots.Changed += OnRootChanged;
        Load += async (_, _) => await InitAsync();
    }

    async Task InitAsync()
    {
        try
        {
            await InitWebViewAsync();
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Could not start the WebView2 browser engine.\n\n{ex.Message}",
                "MRAkdown", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
            return;
        }

        var root = _startRoot ?? PickFolder();
        if (root is null)
        {
            Close();
            return;
        }
        var query = $"?r={root.Id}" + (_startNote is null ? "" : "&n=" + Uri.EscapeDataString(_startNote));
        _web.CoreWebView2.Navigate(Origin + "/" + query);
    }

    async Task InitWebViewAsync()
    {
        s_environment ??= CoreWebView2Environment.CreateAsync(null, Path.Combine(Roots.DataDir, "WebView2"));
        try
        {
            await _web.EnsureCoreWebView2Async(await s_environment);
        }
        catch (COMException ex) when (ex.HResult == unchecked((int)0x8007139F))
        {
            // Another process owns the shared browser profile with different options
            // (e.g. extra WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS). Use a separate profile instead.
            s_environment = CoreWebView2Environment.CreateAsync(null, Path.Combine(Roots.DataDir, "WebView2-alt"));
            await _web.EnsureCoreWebView2Async(await s_environment);
        }

        var core = _web.CoreWebView2;
        core.Settings.IsStatusBarEnabled = false;
        // Content is served locally; SmartScreen's online lookup of notes.local stalls each page load by ~2 s.
        core.Settings.IsReputationCheckingRequired = false;
        core.AddWebResourceRequestedFilter(Origin + "/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += OnWebResourceRequested;
        core.WebMessageReceived += OnWebMessage;
        core.DocumentTitleChanged += (_, _) => Text = core.DocumentTitle;
        core.NewWindowRequested += (_, e) => { e.Handled = true; OpenExternal(e.Uri); };
        core.NavigationStarting += (_, e) =>
        {
            if (e.Uri.StartsWith(Origin + "/", StringComparison.OrdinalIgnoreCase)) return;
            e.Cancel = true;
            OpenExternal(e.Uri);
        };
    }

    NoteIndex? PickFolder()
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = "Choose a folder of Markdown notes",
            UseDescriptionForTitle = true,
            InitialDirectory = Roots.ReadLastRoot() ?? Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
        };
        return dialog.ShowDialog(this) == DialogResult.OK ? Roots.Get(dialog.SelectedPath) : null;
    }

    /* ---------- Opening things from outside the page ---------- */

    public void OpenFileInTab(string file)
    {
        var root = Roots.ForFile(file);
        PostToPage(new { type = "openTab", root = root.Id, rootName = root.Name, path = root.Rel(file) });
        BringToFront();
    }

    public void OpenFolderInTab(NoteIndex root)
    {
        PostToPage(new { type = "openFolder", root = root.Id, rootName = root.Name });
        BringToFront();
    }

    new void BringToFront()
    {
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
    }

    void PostToPage(object message)
    {
        if (!_pageReady)
        {
            _pendingMessages.Add(message);
            return;
        }
        _web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(message));
    }

    void OnRootChanged(NoteIndex root)
    {
        if (_pageReady) PostToPage(new { type = "changed", root = root.Id });
    }

    /* ---------- Serving the page and notes ---------- */

    async void OnWebResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var uri = new Uri(e.Request.Uri);
        var path = Uri.UnescapeDataString(uri.AbsolutePath);
        var query = HttpUtility.ParseQueryString(uri.Query);

        if (path == "/__api/tree" && Roots.Find(query["r"]) is { } treeRoot)
        {
            // Deferred so the tree request can await the background folder scan without blocking anything else.
            var deferral = e.GetDeferral();
            try
            {
                e.Response = Respond(Encoding.UTF8.GetBytes(await treeRoot.TreeJsonAsync()), "application/json");
            }
            catch (Exception ex)
            {
                e.Response = Respond(Encoding.UTF8.GetBytes(ex.Message), "text/plain", 500);
            }
            finally
            {
                deferral.Complete();
            }
            return;
        }

        try
        {
            if (path == "/")
                e.Response = Respond(ReadResource("app.html"), "text/html");
            else if (path.StartsWith("/__app/"))
                e.Response = Respond(ReadResource(path["/__app/".Length..]), MimeType(path));
            else if (path.StartsWith("/__api/") && Roots.Find(query["r"]) is { } root)
                e.Response = HandleApi(path, root, query["n"] ?? "", e.Request);
            else if (ResolveFileUrl(path) is { } full && File.Exists(full))
                // Read into memory so we never hold a lock on the user's files.
                e.Response = Respond(File.ReadAllBytes(full), MimeType(full));
            else
                e.Response = Respond([], "text/plain", 404);
        }
        catch (FileNotFoundException)
        {
            e.Response = Respond([], "text/plain", 404);
        }
        catch (Exception ex)
        {
            e.Response = Respond(Encoding.UTF8.GetBytes(ex.Message), "text/plain", 500);
        }
    }

    /// <summary>Maps /f/{root id}/{relative path} to a file on disk.</summary>
    static string? ResolveFileUrl(string path)
    {
        if (!path.StartsWith("/f/")) return null;
        var slash = path.IndexOf('/', 3);
        if (slash < 0) return null;
        return Roots.Find(path[3..slash])?.FullPath(path[(slash + 1)..]);
    }

    CoreWebView2WebResourceResponse HandleApi(string path, NoteIndex index, string note, CoreWebView2WebResourceRequest request)
    {
        var isPost = request.Method == "POST";
        return (path, isPost) switch
        {
            ("/__api/note", false) => Json(index.RenderJson(note)),
            ("/__api/source", false) => Respond(Encoding.UTF8.GetBytes(index.ReadSource(note)), "text/plain"),
            ("/__api/render", true) => Json(index.RenderJson(note, ReadBody(request))),
            ("/__api/save", true) => SaveNote(),
            ("/__api/upload", true) => Json(JsonSerializer.Serialize(new
            {
                link = index.SaveAttachment(note, HttpUtility.ParseQueryString(new Uri(request.Uri).Query)["name"] ?? "image.png", ReadBodyBytes(request)),
            })),
            _ => Respond([], "text/plain", 404),
        };

        CoreWebView2WebResourceResponse Json(string json) => Respond(Encoding.UTF8.GetBytes(json), "application/json");

        CoreWebView2WebResourceResponse SaveNote()
        {
            index.Save(note, ReadBody(request));
            return Respond([], "text/plain");
        }
    }

    static byte[] ReadBodyBytes(CoreWebView2WebResourceRequest request)
    {
        if (request.Content is null) return [];
        using var ms = new MemoryStream();
        request.Content.CopyTo(ms);
        return ms.ToArray();
    }

    static string ReadBody(CoreWebView2WebResourceRequest request)
    {
        if (request.Content is null) return "";
        using var reader = new StreamReader(request.Content, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    CoreWebView2WebResourceResponse Respond(byte[] body, string contentType, int status = 200) =>
        _web.CoreWebView2.Environment.CreateWebResourceResponse(
            new MemoryStream(body), status, status == 200 ? "OK" : "Error",
            $"Content-Type: {contentType}; charset=utf-8\r\nCache-Control: no-store");

    static byte[] ReadResource(string name)
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("web/" + name)
            ?? throw new FileNotFoundException(name);
        using var ms = new MemoryStream();
        stream.CopyTo(ms);
        return ms.ToArray();
    }

    static string MimeType(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".html" => "text/html",
        ".css" => "text/css",
        ".js" => "text/javascript",
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".svg" => "image/svg+xml",
        ".bmp" => "image/bmp",
        ".avif" => "image/avif",
        ".pdf" => "application/pdf",
        ".md" or ".markdown" or ".txt" => "text/plain",
        _ => "application/octet-stream",
    };

    /* ---------- Messages from the page ---------- */

    void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        using var msg = JsonDocument.Parse(e.WebMessageAsJson);
        var m = msg.RootElement;
        string? Str(string name) => m.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

        switch (Str("type"))
        {
            case "ready":
                _pageReady = true;
                foreach (var pending in _pendingMessages) PostToPage(pending);
                _pendingMessages.Clear();
                break;
            case "openFolder":
                if (PickFolder() is { } root) OpenFolderInTab(root);
                break;
            case "openFileDialog":
                using (var dialog = new OpenFileDialog
                {
                    Title = "Open file",
                    Filter = "All files (*.*)|*.*|Markdown files (*.md)|*.md;*.markdown|Text files (*.txt)|*.txt",
                    Multiselect = true,
                    InitialDirectory = Roots.Find(Str("root"))?.Root ?? Roots.ReadLastRoot() ?? "",
                })
                {
                    if (dialog.ShowDialog(this) == DialogResult.OK)
                        foreach (var file in dialog.FileNames) OpenFileInTab(file);
                }
                break;
            case "dragOut":
                DragOut(m, Str("root"), Str("path"), m.GetProperty("last").GetBoolean());
                break;
            case "openWindow":
                if (Roots.Find(Str("root")) is { } windowRoot)
                {
                    // Cascade the new window slightly from this one.
                    var bounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                    bounds.Offset(32, 32);
                    _app.OpenWindow(windowRoot, Str("path"), bounds);
                }
                break;
            case "closeWindow":
                Close();
                break;
            case "saveAs":
                Reply(m, SaveNewNote(Str("root"), Str("text") ?? "", Str("name")));
                break;
            case "askSave":
                Reply(m, MessageBox.Show(this, $"Do you want to save \"{Str("title")}\"?", "MRAkdown",
                    MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question) switch
                {
                    DialogResult.Yes => "yes",
                    DialogResult.No => "no",
                    _ => "cancel",
                });
                break;
            case "closeCancelled":
                // The user chose Cancel when asked to save a new note while closing.
                _closeRequested = false;
                break;
            case "open":
                OpenExternal(Str("url") ?? "");
                break;
            case "openFile":
                if (Roots.Find(Str("root"))?.FullPath(Str("path") ?? "") is { } full && File.Exists(full))
                    Process.Start(new ProcessStartInfo(full) { UseShellExecute = true });
                break;
            case "dirty":
                _hasUnsavedEdits = m.GetProperty("value").GetBoolean();
                _closeRequested = false;
                break;
            case "closeReady":
                _hasUnsavedEdits = false;
                Close();
                break;
        }
    }

    /// <summary>
    /// A tab was dragged out of this window and dropped at a screen point. Over another MRAkdown window it moves
    /// there (and if it was this window's last tab, this window closes: the two merge). Elsewhere it opens in a
    /// new window, unless it was the last tab. The page is told whether the tab left, so it can remove it.
    /// </summary>
    void DragOut(JsonElement m, string? rootId, string? note, bool isLast)
    {
        var root = Roots.Find(rootId);
        // The page reports CSS pixels; convert to physical pixels for this monitor.
        var scale = DeviceDpi / 96.0;
        var drop = new Point((int)(m.GetProperty("x").GetDouble() * scale), (int)(m.GetProperty("y").GetDouble() * scale));
        var moved = false;

        if (root is not null && _app.WindowAt(drop, this) is { } target)
        {
            target.ReceiveTab(root, note, drop, m.GetProperty("scroll").GetDouble());
            moved = true;
        }
        else if (root is not null && !isLast)
        {
            var size = WindowState == FormWindowState.Normal ? Size : RestoreBounds.Size;
            _app.OpenWindow(root, note, new Rectangle(new Point(drop.X - 120, drop.Y - 20), size));
            moved = true;
        }

        if (moved && isLast)
        {
            // The page saved any edits before dragging, so nothing is lost.
            _hasUnsavedEdits = false;
            Close();
            return;
        }
        PostToPage(new { type = "dragOutResult", id = m.GetProperty("id").GetInt32(), moved });
    }

    /// <summary>A tab dragged in from another window: insert it where it was dropped in the tab bar.</summary>
    public void ReceiveTab(NoteIndex root, string? note, Point screenPoint, double scroll)
    {
        var x = PointToClient(screenPoint).X / (DeviceDpi / 96.0);
        PostToPage(new { type = "openTab", root = root.Id, rootName = root.Name, path = note, x, scroll });
        BringToFront();
    }

    /// <summary>Answers a request the page made with an id (see callHost in app.js).</summary>
    void Reply(JsonElement request, object? value) =>
        PostToPage(new { type = "reply", id = request.GetProperty("id").GetInt32(), value });

    /// <summary>
    /// First save of a new note: asks where to save it, writes it, and returns where it ended up
    /// ({ root, rootName, path }), or null if the user cancelled.
    /// </summary>
    object? SaveNewNote(string? rootId, string text, string? suggestedName)
    {
        var root = Roots.Find(rootId);
        using var dialog = new SaveFileDialog
        {
            Title = "Save note",
            Filter = "Markdown files (*.md)|*.md",
            DefaultExt = "md",
            AddExtension = true,
            OverwritePrompt = true,
            FileName = string.IsNullOrWhiteSpace(suggestedName) ? "Untitled.md" : suggestedName + ".md",
            InitialDirectory = root?.Root ?? Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
        };
        if (dialog.ShowDialog(this) != DialogResult.OK) return null;

        var file = Path.GetFullPath(dialog.FileName);
        if (!NoteIndex.IsMarkdown(file)) file += ".md";
        try
        {
            File.WriteAllText(file, text, new UTF8Encoding(false));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            MessageBox.Show(this, $"Could not save the note.\n\n{ex.Message}", "MRAkdown",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            return null;
        }

        // Keep it in the current folder if it was saved inside it; otherwise open its own folder.
        var target = root is not null && file.StartsWith(root.Root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
            ? root
            : Roots.ForFile(file);
        return new { root = target.Id, rootName = target.Name, path = target.Rel(file) };
    }

    static void OpenExternal(string url)
    {
        if (Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https" or "mailto")
            Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        // Let the page save unsaved edits first; it answers with "closeReady".
        if (_hasUnsavedEdits && _web.CoreWebView2 is not null)
        {
            if (!_closeRequested)
            {
                _closeRequested = true;
                e.Cancel = true;
                PostToPage(new { type = "saveAndClose" });
            }
            else
            {
                // Closing again while the save hasn't confirmed (e.g. it failed): ask before losing edits.
                e.Cancel = MessageBox.Show(this, "Your changes could not be saved. Close anyway?", "MRAkdown",
                    MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes;
            }
        }
        base.OnFormClosing(e);
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        Roots.Changed -= OnRootChanged;
        base.OnFormClosed(e);
    }

    static bool IsDarkMode() =>
        Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
            "AppsUseLightTheme", 1) is 0;

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        if (IsDarkMode())
        {
            var on = 1;
            DwmSetWindowAttribute(Handle, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, ref on, sizeof(int));
        }
    }
}
