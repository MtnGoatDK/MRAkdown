using System.Text.Json;

namespace MRAkdown;

/// <summary>
/// One window: a WebKitGTK page with tabs. Notes are served from <see cref="Roots"/> under
/// /f/{root id}/..., so tabs can show notes from different folders (see <see cref="WebHost"/>).
/// </summary>
sealed class MainWindow
{
    readonly MRAkdownApp _app;
    readonly WebKit.WebView _web;
    readonly NoteIndex? _startRoot;
    readonly string? _startNote;
    // Messages for the page that arrive before it has loaded; sent once it reports "ready".
    readonly List<object> _pendingMessages = [];
    // Whether the pointer is over this window, and where over the page: used to find where a dragged tab was dropped.
    readonly Gtk.EventControllerMotion _windowPointer = Gtk.EventControllerMotion.New();
    readonly Gtk.EventControllerMotion _pagePointer = Gtk.EventControllerMotion.New();
    double _pagePointerX;
    bool _started;
    bool _pageReady;
    bool _hasUnsavedEdits;
    bool _closeRequested;
    bool _forceClose;

    public Adw.ApplicationWindow Window { get; }

    public bool ContainsPointer => _windowPointer.ContainsPointer;

    public MainWindow(MRAkdownApp app, NoteIndex? root, string? note)
    {
        _app = app;
        _startRoot = root;
        _startNote = note;

        Window = Adw.ApplicationWindow.New(app.Application);
        Window.SetTitle("MRAkdown");
        Window.SetIconName(Program.AppId);
        Window.SetDefaultSize(1200, 800);

        _web = WebKit.WebView.NewWithProperties(
            [new GObject.ConstructArgument("network-session", new GObject.Value(WebHost.Session))]);
        var background = new Gdk.RGBA();
        background.Parse(Adw.StyleManager.GetDefault().GetDark() ? "#1e1e1e" : "#ffffff");
        _web.SetBackgroundColor(background);
        // MRAKDOWN_DEVTOOLS=1: right-click > Inspect Element, and the page's console messages on stdout.
        var devTools = Environment.GetEnvironmentVariable("MRAKDOWN_DEVTOOLS") == "1";
        _web.GetSettings().SetEnableDeveloperExtras(devTools);
        _web.GetSettings().SetEnableWriteConsoleMessagesToStdout(devTools);

        // No title bar: the page's top bar takes its place, with the window buttons the desktop is set to show.
        Window.SetContent(_web);

        // The page posts to window.webkit.messageHandlers.host (see hostBridge in app.js).
        var messages = _web.GetUserContentManager();
        messages.AddScript(WebKit.UserScript.New(
            $"window.hostWindowControls = {JsonSerializer.Serialize(WindowControls())};",
            WebKit.UserContentInjectedFrames.TopFrame, WebKit.UserScriptInjectionTime.Start, null, null));
        messages.RegisterScriptMessageHandler("host", null);
        messages.OnScriptMessageReceived += (_, e) => OnWebMessage(e.Value.ToJson(0));

        WebKit.WebView.TitlePropertyDefinition.Notify(_web, (_, _) => Window.SetTitle(_web.GetTitle() ?? "MRAkdown"), false);
        _web.OnDecidePolicy += (_, e) => OnDecidePolicy(e.Decision, e.DecisionType);
        // No browser menu (Back, Reload, ...): the page has its own. Keep it for text fields and selections (copy, paste).
        _web.OnContextMenu += (_, e) => !(e.HitTestResult.ContextIsEditable() || e.HitTestResult.ContextIsSelection());

        Window.AddController(_windowPointer);
        _pagePointer.OnEnter += (_, e) => _pagePointerX = e.X;
        _pagePointer.OnMotion += (_, e) => _pagePointerX = e.X;
        _web.AddController(_pagePointer);

        Window.OnCloseRequest += (_, _) => OnCloseRequest();
        Window.OnMap += (_, _) =>
        {
            if (_started) return;
            _started = true;
            _ = InitAsync();
        };
        Roots.Changed += OnRootChanged;
        Window.OnDestroy += (_, _) => Roots.Changed -= OnRootChanged;
    }

    /// <summary>
    /// The window buttons for each end of the top bar, from the desktop's button layout (gtk-decoration-layout,
    /// e.g. "appmenu:minimize,maximize,close": left of the colon goes left).
    /// </summary>
    static object WindowControls()
    {
        var layout = Gtk.Settings.GetDefault()?.GtkDecorationLayout ?? ":close";
        string[] Buttons(string side) => side.Split(',', StringSplitOptions.TrimEntries)
            .Where(b => b is "minimize" or "maximize" or "close").ToArray();
        var colon = layout.IndexOf(':');
        return colon < 0
            ? new { left = Buttons(layout), right = Array.Empty<string>() }
            : new { left = Buttons(layout[..colon]), right = Buttons(layout[(colon + 1)..]) };
    }

    async Task InitAsync()
    {
        var root = _startRoot ?? await PickFolderAsync();
        if (root is null)
        {
            Window.Close();
            return;
        }
        var query = $"?r={root.Id}" + (_startNote is null ? "" : "&n=" + Uri.EscapeDataString(_startNote));
        _web.LoadUri(WebHost.Origin + "/" + query);
    }

    /// <summary>Keeps the page on our own URLs; links to anything else open in the default browser.</summary>
    bool OnDecidePolicy(WebKit.PolicyDecision decision, WebKit.PolicyDecisionType type)
    {
        if (decision is not WebKit.NavigationPolicyDecision navigation) return false;
        var action = navigation.GetNavigationAction();
        var uri = action.GetRequest().GetUri() ?? "";
        if (type == WebKit.PolicyDecisionType.NavigationAction)
        {
            // Frames (e.g. an embedded video) load what they like; only the page's own navigation is kept in.
            if (uri.StartsWith(WebHost.Origin + "/", StringComparison.Ordinal)) return false;
            if (action.GetNavigationType() is not (WebKit.NavigationType.LinkClicked or WebKit.NavigationType.FormSubmitted))
                return false;
        }
        decision.Ignore();
        OpenExternal(uri);
        return true;
    }

    async Task<NoteIndex?> PickFolderAsync()
    {
        var dialog = Gtk.FileDialog.New();
        dialog.SetTitle("Choose a folder");
        dialog.SetInitialFolder(Gio.FileHelper.NewForPath(
            Roots.ReadLastRoot() ?? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)));
        try
        {
            return (await dialog.SelectFolderAsync(Window))?.GetPath() is { } path ? Roots.Get(path) : null;
        }
        catch (GLib.GException)
        {
            return null; // Cancelled.
        }
    }

    /* ---------- Opening things from outside the page ---------- */

    public void OpenFileInTab(string file)
    {
        var root = Roots.ForFile(file);
        PostToPage(new { type = "openTab", root = root.Id, rootName = root.Name, path = root.Rel(file) });
        Window.Present();
    }

    public void OpenFolderInTab(NoteIndex root)
    {
        PostToPage(new { type = "openFolder", root = root.Id, rootName = root.Name });
        Window.Present();
    }

    void PostToPage(object message)
    {
        if (!_pageReady)
        {
            _pendingMessages.Add(message);
            return;
        }
        // The page listens for "host-message" events (see hostBridge in app.js).
        var script = $"window.dispatchEvent(new CustomEvent('host-message', {{ detail: {JsonSerializer.Serialize(message)} }}))";
        _web.EvaluateJavascriptAsync(script).ContinueWith(
            t => Console.Error.WriteLine($"Could not send a message to the page: {t.Exception?.GetBaseException().Message}"),
            TaskContinuationOptions.OnlyOnFaulted);
    }

    void OnRootChanged(NoteIndex root)
    {
        if (_pageReady) PostToPage(new { type = "changed", root = root.Id });
    }

    /* ---------- Messages from the page ---------- */

    async void OnWebMessage(string json)
    {
        using var msg = JsonDocument.Parse(json);
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
                if (await PickFolderAsync() is { } root) OpenFolderInTab(root);
                break;
            case "openFileDialog":
                foreach (var file in await PickFilesAsync(Str("root"))) OpenFileInTab(file);
                break;
            case "dragOut":
                DragOut(Str("root"), Str("path"), m.GetProperty("id").GetInt32(), m.GetProperty("scroll").GetDouble(),
                    m.GetProperty("last").GetBoolean());
                break;
            case "openWindow":
                if (Roots.Find(Str("root")) is { } windowRoot)
                    _app.OpenWindow(windowRoot, Str("path"), (Window.GetWidth(), Window.GetHeight()));
                break;
            case "closeWindow":
                Window.Close();
                break;
            case "minimize":
                Window.Minimize();
                break;
            case "maximize":
                if (Window.IsMaximized()) Window.Unmaximize();
                else Window.Maximize();
                break;
            case "windowDrag":
                // The pointer is still down on the page's top bar: let the desktop move the window from here.
                if (Window.GetSurface() is Gdk.Toplevel toplevel && Gdk.Display.GetDefault()?.GetDefaultSeat()?.GetPointer() is { } pointer)
                    toplevel.BeginMove(pointer, 1, m.GetProperty("x").GetDouble(), m.GetProperty("y").GetDouble(), 0);
                break;
            case "titlebarGesture":
                TitlebarGesture(Str("gesture"));
                break;
            case "saveAs":
            {
                var id = m.GetProperty("id").GetInt32();
                Reply(id, await SaveNewNoteAsync(Str("root"), Str("text") ?? "", Str("name")));
                break;
            }
            case "askSave":
            {
                var id = m.GetProperty("id").GetInt32();
                var answer = await AskAsync("Save changes?", $"Do you want to save \"{Str("title")}\"?", "cancel",
                    ("cancel", "_Cancel", Adw.ResponseAppearance.Default),
                    ("no", "_Don't Save", Adw.ResponseAppearance.Destructive),
                    ("yes", "_Save", Adw.ResponseAppearance.Suggested));
                Reply(id, answer);
                break;
            }
            case "confirm":
            {
                // A yes/no question from the page (e.g. overwrite a file that changed on disk); the answer is true for yes.
                var id = m.GetProperty("id").GetInt32();
                var answer = await AskAsync(Str("title") ?? "MRAkdown", Str("message") ?? "", "no",
                    ("no", "_Cancel", Adw.ResponseAppearance.Default),
                    ("yes", Str("yes") ?? "_OK", Adw.ResponseAppearance.Destructive));
                Reply(id, answer == "yes");
                break;
            }
            case "closeCancelled":
                // The user chose Cancel when asked to save a new note while closing.
                _closeRequested = false;
                break;
            case "open":
                OpenExternal(Str("url") ?? "");
                break;
            case "openFile":
                if (Roots.Find(Str("root"))?.FullPath(Str("path") ?? "") is { } full && File.Exists(full))
                    await LaunchAsync(Gtk.FileLauncher.New(Gio.FileHelper.NewForPath(full)).LaunchAsync(Window));
                break;
            case "dirty":
                _hasUnsavedEdits = m.GetProperty("value").GetBoolean();
                _closeRequested = false;
                break;
            case "closeReady":
                _hasUnsavedEdits = false;
                Window.Close();
                break;
        }
    }

    /// <summary>
    /// A double, middle or right click on the page's top bar: do what the desktop does for title bars. Like GTK's own
    /// title bars, ask the desktop first, and if it doesn't handle it, follow the user's GTK title bar click settings.
    /// </summary>
    void TitlebarGesture(string? gesture)
    {
        var settings = Gtk.Settings.GetDefault();
        Gdk.TitlebarGesture kind;
        string? setting;
        switch (gesture)
        {
            case "double-click": kind = Gdk.TitlebarGesture.DoubleClick; setting = settings?.GtkTitlebarDoubleClick; break;
            case "middle-click": kind = Gdk.TitlebarGesture.MiddleClick; setting = settings?.GtkTitlebarMiddleClick; break;
            case "right-click": kind = Gdk.TitlebarGesture.RightClick; setting = settings?.GtkTitlebarRightClick; break;
            default: return;
        }
        var handled = Window.GetSurface() is Gdk.Toplevel toplevel && toplevel.TitlebarGesture(kind);
        if (handled) return;
        switch (setting)
        {
            case "toggle-maximize":
                if (Window.IsMaximized()) Window.Unmaximize();
                else Window.Maximize();
                break;
            case "minimize":
                Window.Minimize();
                break;
        }
    }

    /// <summary>
    /// A tab was dragged out of this window and dropped. Over another MRAkdown window it moves there (and if it was
    /// this window's last tab, this window closes: the two merge). Elsewhere it opens in a new window, unless it was
    /// the last tab. The page is told whether the tab left, so it can remove it.
    /// </summary>
    void DragOut(string? rootId, string? note, int id, double scroll, bool isLast)
    {
        // Wayland gives no global pointer position, so the page's screen coordinates are no use. Instead, wait a
        // moment for the compositor to tell the window under the pointer that the pointer entered it.
        GLib.Functions.TimeoutAdd(GLib.Constants.PRIORITY_DEFAULT, 150, () =>
        {
            var root = Roots.Find(rootId);
            var moved = false;
            if (root is not null && _app.WindowUnderPointer(this) is { } target)
            {
                target.ReceiveTab(root, note, scroll);
                moved = true;
            }
            else if (root is not null && !isLast)
            {
                _app.OpenWindow(root, note, (Window.GetWidth(), Window.GetHeight()));
                moved = true;
            }

            if (moved && isLast)
            {
                // The page saved any edits before dragging, so nothing is lost.
                _hasUnsavedEdits = false;
                Window.Close();
            }
            else
            {
                PostToPage(new { type = "dragOutResult", id, moved });
            }
            return false;
        });
    }

    /// <summary>A tab dragged in from another window: insert it where it was dropped in the tab bar.</summary>
    public void ReceiveTab(NoteIndex root, string? note, double scroll)
    {
        // Dropped over the header bar rather than the page: add it at the end.
        var x = _pagePointer.ContainsPointer ? _pagePointerX : 1e6;
        PostToPage(new { type = "openTab", root = root.Id, rootName = root.Name, path = note, x, scroll });
        Window.Present();
    }

    /// <summary>Answers a request the page made with an id (see callHost in app.js).</summary>
    void Reply(int id, object? value) => PostToPage(new { type = "reply", id, value });

    async Task<IEnumerable<string>> PickFilesAsync(string? rootId)
    {
        var all = Filter("All files", "*");
        var dialog = Gtk.FileDialog.New();
        dialog.SetTitle("Open file");
        dialog.SetFilters(Filters(all, Filter("Markdown files", "*.md", "*.markdown"), Filter("Text files", "*.txt")));
        dialog.SetDefaultFilter(all);
        if ((Roots.Find(rootId)?.Root ?? Roots.ReadLastRoot()) is { } folder)
            dialog.SetInitialFolder(Gio.FileHelper.NewForPath(folder));
        try
        {
            if (await dialog.OpenMultipleAsync(Window) is not { } files) return [];
            return Enumerable.Range(0, (int)files.GetNItems())
                .Select(i => (files.GetObject((uint)i) as Gio.File)?.GetPath())
                .OfType<string>()
                .ToList();
        }
        catch (GLib.GException)
        {
            return []; // Cancelled.
        }
    }

    /// <summary>
    /// First save of a new note: asks where to save it, writes it, and returns where it ended up
    /// ({ root, rootName, path }), or null if the user cancelled.
    /// </summary>
    async Task<object?> SaveNewNoteAsync(string? rootId, string text, string? suggestedName)
    {
        var root = Roots.Find(rootId);
        var markdown = Filter("Markdown files", "*.md");
        var dialog = Gtk.FileDialog.New();
        dialog.SetTitle("Save file");
        dialog.SetFilters(Filters(markdown));
        dialog.SetDefaultFilter(markdown);
        dialog.SetInitialName(string.IsNullOrWhiteSpace(suggestedName) ? "Untitled.md" : suggestedName + ".md");
        dialog.SetInitialFolder(Gio.FileHelper.NewForPath(
            root?.Root ?? Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments)));

        string? file;
        try
        {
            file = (await dialog.SaveAsync(Window))?.GetPath();
        }
        catch (GLib.GException)
        {
            return null; // Cancelled.
        }
        if (file is null) return null;

        try
        {
            return Roots.SaveNewNote(root, file, text);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            await AskAsync("Could not save the file", ex.Message, "ok", ("ok", "_OK", Adw.ResponseAppearance.Default));
            return null;
        }
    }

    static Gtk.FileFilter Filter(string name, params string[] patterns)
    {
        var filter = Gtk.FileFilter.New();
        filter.SetName(name);
        foreach (var pattern in patterns) filter.AddPattern(pattern);
        return filter;
    }

    static Gio.ListStore Filters(params Gtk.FileFilter[] filters)
    {
        var list = Gio.ListStore.New(Gtk.FileFilter.GetGType());
        foreach (var filter in filters) list.Append(filter);
        return list;
    }

    /// <summary>Shows a message with buttons (id, label, appearance) and returns the id chosen, or the close id.</summary>
    Task<string> AskAsync(string heading, string body, string closeResponse,
        params (string Id, string Label, Adw.ResponseAppearance Appearance)[] responses)
    {
        var dialog = Adw.AlertDialog.New(heading, body);
        foreach (var (id, label, appearance) in responses)
        {
            dialog.AddResponse(id, label);
            dialog.SetResponseAppearance(id, appearance);
        }
        dialog.SetDefaultResponse(responses[^1].Id);
        dialog.SetCloseResponse(closeResponse);
        var answer = new TaskCompletionSource<string>();
        dialog.OnResponse += (_, e) => answer.TrySetResult(e.Response);
        dialog.Present(Window);
        return answer.Task;
    }

    void OpenExternal(string url)
    {
        if (Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https" or "mailto")
            _ = LaunchAsync(Gtk.UriLauncher.New(uri.AbsoluteUri).LaunchAsync(Window));
    }

    /// <summary>Waits for a file or URL launch; failing or being cancelled (e.g. no app chosen) is not an error.</summary>
    static async Task LaunchAsync(Task<bool> launch)
    {
        try
        {
            await launch;
        }
        catch (GLib.GException) { }
    }

    /// <returns>True to keep the window open.</returns>
    bool OnCloseRequest()
    {
        if (_forceClose || !_hasUnsavedEdits) return false;

        // Let the page save unsaved edits first; it answers with "closeReady".
        if (!_closeRequested)
        {
            _closeRequested = true;
            PostToPage(new { type = "saveAndClose" });
            return true;
        }

        // Closing again while the save hasn't confirmed (e.g. it failed): ask before losing edits.
        _ = ConfirmCloseAsync();
        return true;

        async Task ConfirmCloseAsync()
        {
            var answer = await AskAsync("Close without saving?", "Your changes could not be saved. Close anyway?", "cancel",
                ("cancel", "_Cancel", Adw.ResponseAppearance.Default),
                ("close", "C_lose", Adw.ResponseAppearance.Destructive));
            if (answer != "close") return;
            _forceClose = true;
            Window.Close();
        }
    }
}
