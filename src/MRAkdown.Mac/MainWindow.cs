using System.Runtime.InteropServices;
using System.Text.Json;
using static MRAkdown.ObjC;

namespace MRAkdown;

/// <summary>
/// One window: a WKWebView page with tabs, under a standard macOS title bar. Notes are served from <see cref="Roots"/>
/// under /f/{root id}/..., so tabs can show notes from different folders (see <see cref="WebHost"/>).
/// </summary>
sealed class MainWindow
{
    // NSWindowStyleMask: titled, closable, miniaturizable, resizable.
    const int StyleMask = 1 | 2 | 4 | 8;
    const int NSBackingStoreBuffered = 2;
    const int NSWindowTabbingModeDisallowed = 2;
    const int WKNavigationActionPolicyCancel = 0, WKNavigationActionPolicyAllow = 1;
    const int WKNavigationTypeLinkActivated = 0, WKNavigationTypeFormSubmitted = 1;
    const int NSModalResponseOK = 1, NSAlertFirstButtonReturn = 1000;

    // The window's delegate object, which also gets the page's messages and navigation, calls back into its window.
    static readonly Dictionary<IntPtr, MainWindow> s_byDelegate = [];
    static IntPtr s_delegateClass, s_webViewClass;

    readonly MRAkdownApp _app;
    readonly IntPtr _window;
    readonly IntPtr _web;
    readonly IntPtr _delegate;
    readonly NoteIndex? _startRoot;
    readonly string? _startNote;
    // Messages for the page that arrive before it has loaded; sent once it reports "ready".
    readonly List<object> _pendingMessages = [];
    bool _pageReady;
    bool _hasUnsavedEdits;
    bool _closeRequested;
    bool _forceClose;
    bool _closed;

    public IntPtr Window => _window;
    public bool HasUnsavedEdits => _hasUnsavedEdits;
    public event Action? Closed;
    public event Action? Activated;

    public MainWindow(MRAkdownApp app, NoteIndex? root, string? note, CGSize size)
    {
        _app = app;
        _startRoot = root;
        _startNote = note;
        DefineClasses();

        var frame = new CGRect(0, 0, size.Width, size.Height);
        _window = Send(Send(Class("NSWindow"), "alloc"), "initWithContentRect:styleMask:backing:defer:",
            frame, StyleMask, NSBackingStoreBuffered, 0);
        // Released by us when it has closed (see OnWillClose).
        Send(_window, "setReleasedWhenClosed:", 0);
        Send(_window, "setTitle:", NSString("MRAkdown"));
        // The page has its own tabs, so no macOS window tabs.
        Send(_window, "setTabbingMode:", NSWindowTabbingModeDisallowed);

        _delegate = Send(Send(s_delegateClass, "alloc"), "init");
        s_byDelegate[_delegate] = this;

        var config = WebHost.CreateConfiguration();
        // The page posts to window.webkit.messageHandlers.host (see hostBridge in app.js).
        Send(Send(config, "userContentController"), "addScriptMessageHandler:name:", _delegate, NSString("host"));
        _web = Send(Send(s_webViewClass, "alloc"), "initWithFrame:configuration:", frame, config);
        Send(config, "release");
        // Transparent until the page paints, so a dark window doesn't flash white.
        Send(_web, "setValue:forKey:", NSNumber(false), NSString("drawsBackground"));
        // MRAKDOWN_DEVTOOLS=1: the page can be inspected from Safari's Develop menu (macOS 13.3 and later).
        if (Environment.GetEnvironmentVariable("MRAKDOWN_DEVTOOLS") == "1" && RespondsTo(_web, "setInspectable:"))
            Send(_web, "setInspectable:", 1);
        Send(_web, "setNavigationDelegate:", _delegate);
        Send(_web, "setUIDelegate:", _delegate);
        // The window title follows the page title.
        Send(_web, "addObserver:forKeyPath:options:context:", _delegate, NSString("title"), 1 /* New */, 0);

        Send(_window, "setContentView:", _web);
        Send(_window, "setDelegate:", _delegate);
        Roots.Changed += OnRootChanged;
    }

    public CGSize ContentSize => SendRect(Send(_window, "contentView"), "frame").Size;

    public nint WindowNumber => _closed ? -1 : Send(_window, "windowNumber");

    public void Present() => Send(_window, "makeKeyAndOrderFront:", 0);

    /// <summary>Loads the page, after asking for a folder if the window has none.</summary>
    public async Task InitAsync()
    {
        // Let the window appear first: the folder dialog is app-modal.
        await Task.Yield();
        var root = _startRoot ?? PickFolder();
        if (root is null)
        {
            Close();
            return;
        }
        if (_closed) return;
        var query = $"?r={root.Id}" + (_startNote is null ? "" : "&n=" + Uri.EscapeDataString(_startNote));
        Send(_web, "loadRequest:", Send(Class("NSURLRequest"), "requestWithURL:",
            Send(Class("NSURL"), "URLWithString:", NSString(WebHost.Origin + "/" + query))));
    }

    /* ---------- Objective-C classes ---------- */

    static unsafe void DefineClasses()
    {
        if (s_delegateClass != 0) return;
        s_delegateClass = DefineClass("MRAkdownWindowDelegate", "NSObject",
            ["NSWindowDelegate", "WKScriptMessageHandler", "WKNavigationDelegate", "WKUIDelegate"],
            ("windowShouldClose:", (IntPtr)(delegate* unmanaged<IntPtr, IntPtr, IntPtr, byte>)&WindowShouldClose, "c@:@"),
            ("windowWillClose:", (IntPtr)(delegate* unmanaged<IntPtr, IntPtr, IntPtr, void>)&WindowWillClose, "v@:@"),
            ("windowDidBecomeKey:", (IntPtr)(delegate* unmanaged<IntPtr, IntPtr, IntPtr, void>)&WindowDidBecomeKey, "v@:@"),
            ("userContentController:didReceiveScriptMessage:",
                (IntPtr)(delegate* unmanaged<IntPtr, IntPtr, IntPtr, IntPtr, void>)&DidReceiveScriptMessage, "v@:@@"),
            ("webView:decidePolicyForNavigationAction:decisionHandler:",
                (IntPtr)(delegate* unmanaged<IntPtr, IntPtr, IntPtr, IntPtr, IntPtr, void>)&DecidePolicy, "v@:@@@?"),
            ("webViewWebContentProcessDidTerminate:",
                (IntPtr)(delegate* unmanaged<IntPtr, IntPtr, IntPtr, void>)&WebContentProcessDidTerminate, "v@:@"),
            ("webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:",
                (IntPtr)(delegate* unmanaged<IntPtr, IntPtr, IntPtr, IntPtr, IntPtr, IntPtr, void>)&RunAlert, "v@:@@@@?"),
            ("observeValueForKeyPath:ofObject:change:context:",
                (IntPtr)(delegate* unmanaged<IntPtr, IntPtr, IntPtr, IntPtr, IntPtr, IntPtr, void>)&ObserveValue, "v@:@@@^v"));
        s_webViewClass = DefineClass("MRAkdownWebView", "WKWebView", [],
            ("willOpenMenu:withEvent:", (IntPtr)(delegate* unmanaged<IntPtr, IntPtr, IntPtr, IntPtr, void>)&WillOpenMenu, "v@:@@"));
    }

    static void With(IntPtr self, Action<MainWindow> action) => Callback(() =>
    {
        if (s_byDelegate.TryGetValue(self, out var window)) action(window);
    });

    [UnmanagedCallersOnly]
    static byte WindowShouldClose(IntPtr self, IntPtr sel, IntPtr sender) =>
        Callback(() => s_byDelegate.TryGetValue(self, out var w) && w.KeepOpen() ? (byte)0 : (byte)1, (byte)1);

    [UnmanagedCallersOnly]
    static void WindowWillClose(IntPtr self, IntPtr sel, IntPtr notification) => With(self, w => w.OnWillClose());

    [UnmanagedCallersOnly]
    static void WindowDidBecomeKey(IntPtr self, IntPtr sel, IntPtr notification) => With(self, w => w.Activated?.Invoke());

    [UnmanagedCallersOnly]
    static void DidReceiveScriptMessage(IntPtr self, IntPtr sel, IntPtr controller, IntPtr message) => With(self, w =>
    {
        var json = Send(Class("NSJSONSerialization"), "dataWithJSONObject:options:error:", Send(message, "body"), 0, 0);
        if (json != 0) w.OnWebMessage(System.Text.Encoding.UTF8.GetString(FromNSData(json)));
    });

    [UnmanagedCallersOnly]
    static void DecidePolicy(IntPtr self, IntPtr sel, IntPtr webView, IntPtr action, IntPtr decisionHandler)
    {
        var allow = Callback(() => !s_byDelegate.TryGetValue(self, out var w) || w.AllowNavigation(action), true);
        InvokeBlock(decisionHandler, allow ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
    }

    [UnmanagedCallersOnly]
    static void WebContentProcessDidTerminate(IntPtr self, IntPtr sel, IntPtr webView) => With(self, w =>
    {
        // The page's process crashed or was ended by the system: start it again.
        w._pageReady = false;
        Send(webView, "reload");
    });

    /// <summary>The page's alert(): WKWebView shows nothing unless the app does.</summary>
    [UnmanagedCallersOnly]
    static void RunAlert(IntPtr self, IntPtr sel, IntPtr webView, IntPtr message, IntPtr frame, IntPtr completionHandler)
    {
        With(self, w => w.Ask("MRAkdown", FromNSString(message) ?? "", ("ok", "OK")));
        InvokeBlock(completionHandler);
    }

    [UnmanagedCallersOnly]
    static void ObserveValue(IntPtr self, IntPtr sel, IntPtr keyPath, IntPtr obj, IntPtr change, IntPtr context) =>
        With(self, w =>
        {
            if (!w._closed) Send(w._window, "setTitle:", NSString(FromNSString(Send(w._web, "title")) is { Length: > 0 } t ? t : "MRAkdown"));
        });

    /// <summary>No browser menu items (Back, Forward, Reload): the page has its own menus.</summary>
    [UnmanagedCallersOnly]
    static void WillOpenMenu(IntPtr self, IntPtr sel, IntPtr menu, IntPtr evt) => Callback(() =>
    {
        SendSuper(self, Class("WKWebView"), "willOpenMenu:withEvent:", menu, evt);
        string[] browserItems = ["WKMenuItemIdentifierGoBack", "WKMenuItemIdentifierGoForward", "WKMenuItemIdentifierReload"];
        foreach (var item in Items(Send(menu, "itemArray")).ToList())
        {
            if (FromNSString(Send(item, "identifier")) is { } id && browserItems.Contains(id)) Send(menu, "removeItem:", item);
        }
        // Separators left at either end.
        while (Send(menu, "numberOfItems") > 0 && SendBool(Send(menu, "itemAtIndex:", 0), "isSeparatorItem"))
            Send(menu, "removeItemAtIndex:", 0);
        while (Send(menu, "numberOfItems") is var n && n > 0 && SendBool(Send(menu, "itemAtIndex:", n - 1), "isSeparatorItem"))
            Send(menu, "removeItemAtIndex:", n - 1);
    });

    /// <summary>Keeps the page on our own URLs; links to anything else open in the default browser.</summary>
    bool AllowNavigation(IntPtr action)
    {
        var url = FromNSString(Send(Send(Send(action, "request"), "URL"), "absoluteString")) ?? "";
        var targetFrame = Send(action, "targetFrame");
        // No target frame: a link that opens a new window (target="_blank").
        if (targetFrame != 0)
        {
            if (url.StartsWith(WebHost.Origin + "/", StringComparison.Ordinal)) return true;
            // Frames (e.g. an embedded video) load what they like; only the page's own navigation is kept in.
            if (!SendBool(targetFrame, "isMainFrame")) return true;
            if ((nint)Send(action, "navigationType") is not (WKNavigationTypeLinkActivated or WKNavigationTypeFormSubmitted))
                return true;
        }
        OpenExternal(url);
        return false;
    }

    /* ---------- Opening things from outside the page ---------- */

    public void OpenFileInTab(string file)
    {
        var root = Roots.ForFile(file);
        PostToPage(new { type = "openTab", root = root.Id, rootName = root.Name, path = root.Rel(file) });
        Present();
    }

    public void OpenFolderInTab(NoteIndex root)
    {
        PostToPage(new { type = "openFolder", root = root.Id, rootName = root.Name });
        Present();
    }

    void PostToPage(object message)
    {
        if (_closed) return;
        if (!_pageReady)
        {
            _pendingMessages.Add(message);
            return;
        }
        // The page listens for "host-message" events (see hostBridge in app.js).
        var script = $"window.dispatchEvent(new CustomEvent('host-message', {{ detail: {JsonSerializer.Serialize(message)} }}))";
        Send(_web, "evaluateJavaScript:completionHandler:", NSString(script), 0);
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

        // Dialogs are app-modal and run their own event loop: not from inside WebKit's call.
        await Task.Yield();
        if (_closed) return;

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
                foreach (var file in PickFiles(Str("root"))) OpenFileInTab(file);
                break;
            case "dragOut":
                DragOut(Str("root"), Str("path"), m.GetProperty("id").GetInt32(), m.GetProperty("scroll").GetDouble(),
                    m.GetProperty("last").GetBoolean());
                break;
            case "openWindow":
                if (Roots.Find(Str("root")) is { } windowRoot) _app.OpenWindow(windowRoot, Str("path"), ContentSize);
                break;
            case "closeWindow":
                Close();
                break;
            case "saveAs":
                Reply(m.GetProperty("id").GetInt32(), SaveNewNote(Str("root"), Str("text") ?? "", Str("name")));
                break;
            case "askSave":
                // macOS order: the default button first (rightmost); Esc picks Cancel, ⌘D Don't Save.
                Reply(m.GetProperty("id").GetInt32(), Ask("Do you want to save the changes you made to “" + Str("title") + "”?",
                    "Your changes will be lost if you don't save them.", ("yes", "Save"), ("cancel", "Cancel"), ("no", "Don't Save")));
                break;
            case "confirm":
                // A yes/no question from the page (e.g. overwrite a file that changed on disk); the answer is true for yes.
                Reply(m.GetProperty("id").GetInt32(), Ask(Str("title") ?? "MRAkdown", Str("message") ?? "",
                    ("yes", (Str("yes") ?? "OK").Replace("_", "")), ("no", "Cancel")) == "yes");
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
                    Send(Send(Class("NSWorkspace"), "sharedWorkspace"), "openURL:", FileUrl(full));
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
    /// A tab was dragged out of this window and dropped. Over another MRAkdown window it moves there (and if it was
    /// this window's last tab, this window closes: the two merge). Elsewhere it opens in a new window, unless it was
    /// the last tab. The page is told whether the tab left, so it can remove it.
    /// </summary>
    void DragOut(string? rootId, string? note, int id, double scroll, bool isLast)
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
            _app.OpenWindow(root, note, ContentSize);
            moved = true;
        }

        if (moved && isLast)
        {
            // The page saved any edits before dragging, so nothing is lost.
            _hasUnsavedEdits = false;
            Close();
        }
        else
        {
            PostToPage(new { type = "dragOutResult", id, moved });
        }
    }

    /// <summary>A tab dragged in from another window: insert it where it was dropped in the tab bar.</summary>
    public void ReceiveTab(NoteIndex root, string? note, double scroll)
    {
        // The pointer in window coordinates, from the bottom left. Dropped on the title bar: add it at the end.
        var pointer = SendPoint(_window, "convertPointFromScreen:", SendPoint(Class("NSEvent"), "mouseLocation"));
        var x = pointer.Y <= ContentSize.Height ? pointer.X : 1e6;
        PostToPage(new { type = "openTab", root = root.Id, rootName = root.Name, path = note, x, scroll });
        Present();
    }

    /// <summary>Answers a request the page made with an id (see callHost in app.js).</summary>
    void Reply(int id, object? value) => PostToPage(new { type = "reply", id, value });

    /* ---------- Dialogs ---------- */

    NoteIndex? PickFolder()
    {
        var panel = Send(Class("NSOpenPanel"), "openPanel");
        Send(panel, "setCanChooseFiles:", 0);
        Send(panel, "setCanChooseDirectories:", 1);
        Send(panel, "setCanCreateDirectories:", 1);
        Send(panel, "setMessage:", NSString("Choose a folder"));
        Send(panel, "setDirectoryURL:", FileUrl(
            Roots.ReadLastRoot() ?? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)));
        if (Send(panel, "runModal") != NSModalResponseOK) return null;
        return FromNSString(Send(Send(panel, "URL"), "path")) is { } path ? Roots.Get(path) : null;
    }

    List<string> PickFiles(string? rootId)
    {
        var panel = Send(Class("NSOpenPanel"), "openPanel");
        Send(panel, "setCanChooseFiles:", 1);
        Send(panel, "setCanChooseDirectories:", 0);
        Send(panel, "setAllowsMultipleSelection:", 1);
        if ((Roots.Find(rootId)?.Root ?? Roots.ReadLastRoot()) is { } folder) Send(panel, "setDirectoryURL:", FileUrl(folder));
        if (Send(panel, "runModal") != NSModalResponseOK) return [];
        return Items(Send(panel, "URLs")).Select(url => FromNSString(Send(url, "path"))).OfType<string>().ToList();
    }

    /// <summary>
    /// First save of a new note: asks where to save it, writes it, and returns where it ended up
    /// ({ root, rootName, path }), or null if the user cancelled.
    /// </summary>
    object? SaveNewNote(string? rootId, string text, string? suggestedName)
    {
        var root = Roots.Find(rootId);
        var panel = Send(Class("NSSavePanel"), "savePanel");
        Send(panel, "setNameFieldStringValue:", NSString(string.IsNullOrWhiteSpace(suggestedName) ? "Untitled.md" : suggestedName + ".md"));
        Send(panel, "setDirectoryURL:", FileUrl(root?.Root ?? Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments)));
        if (Send(Class("UTType"), "typeWithFilenameExtension:", NSString("md")) is var markdown && markdown != 0)
            Send(panel, "setAllowedContentTypes:", Send(Class("NSArray"), "arrayWithObject:", markdown));
        if (Send(panel, "runModal") != NSModalResponseOK) return null;
        if (FromNSString(Send(Send(panel, "URL"), "path")) is not { } file) return null;

        try
        {
            return Roots.SaveNewNote(root, file, text);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Ask("Could not save the file", ex.Message, ("ok", "OK"));
            return null;
        }
    }

    /// <summary>Shows a message with buttons (id, label), the default one first, and returns the id chosen.</summary>
    string Ask(string heading, string body, params (string Id, string Label)[] buttons)
    {
        var alert = New("NSAlert");
        Send(alert, "setMessageText:", NSString(heading));
        Send(alert, "setInformativeText:", NSString(body));
        foreach (var (_, label) in buttons) Send(alert, "addButtonWithTitle:", NSString(label));
        var index = (int)Send(alert, "runModal") - NSAlertFirstButtonReturn;
        Send(alert, "release");
        return index >= 0 && index < buttons.Length ? buttons[index].Id : buttons[^1].Id;
    }

    static void OpenExternal(string url)
    {
        if (Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https" or "mailto")
            Send(Send(Class("NSWorkspace"), "sharedWorkspace"), "openURL:",
                Send(Class("NSURL"), "URLWithString:", NSString(uri.AbsoluteUri)));
    }

    /* ---------- Closing ---------- */

    /// <summary>Closes the window, unless it has unsaved edits: then the page saves them first (see KeepOpen).</summary>
    public void Close()
    {
        if (!_closed && !KeepOpen()) Send(_window, "close");
    }

    /// <returns>True to keep the window open.</returns>
    bool KeepOpen()
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
        SynchronizationContext.Current!.Post(_ =>
        {
            if (_closed || Ask("Close without saving?", "Your changes could not be saved. Close anyway?",
                    ("close", "Close"), ("cancel", "Cancel")) != "close") return;
            _forceClose = true;
            Close();
        }, null);
        return true;
    }

    void OnWillClose()
    {
        _closed = true;
        Roots.Changed -= OnRootChanged;
        // Detach everything that points at the delegate, then release what this window created once AppKit is done.
        Send(_web, "removeObserver:forKeyPath:", _delegate, NSString("title"));
        Send(Send(Send(_web, "configuration"), "userContentController"), "removeScriptMessageHandlerForName:", NSString("host"));
        Send(_web, "setNavigationDelegate:", 0);
        Send(_web, "setUIDelegate:", 0);
        Send(_window, "setDelegate:", 0);
        s_byDelegate.Remove(_delegate);
        Closed?.Invoke();
        Send(_web, "autorelease");
        Send(_delegate, "autorelease");
        Send(_window, "autorelease");
    }
}
