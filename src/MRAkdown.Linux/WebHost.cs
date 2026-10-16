namespace MRAkdown;

/// <summary>
/// WebKit setup shared by all windows: the page and notes are served by <see cref="NoteServer"/> under a custom
/// URL scheme (mrakdown://notes/...), and one browser profile keeps the page's settings (localStorage).
/// </summary>
static class WebHost
{
    public const string Scheme = "mrakdown";
    public const string Origin = Scheme + "://notes";

    static WebKit.NetworkSession? s_session;

    public static WebKit.NetworkSession Session => s_session ?? throw new InvalidOperationException("Call Initialize first");

    public static void Initialize()
    {
        var context = WebKit.WebContext.GetDefault();
        // Secure, so the page gets the same APIs as on https (e.g. the async clipboard for pasting images).
        context.GetSecurityManager().RegisterUriSchemeAsSecure(Scheme);
        context.RegisterUriScheme(Scheme, OnRequest);

        var cacheHome = Environment.GetEnvironmentVariable("XDG_CACHE_HOME") is { Length: > 0 } c
            ? c
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".cache");
        s_session = WebKit.NetworkSession.New(Path.Combine(Roots.DataDir, "WebKit"), Path.Combine(cacheHome, "MRAkdown"));
    }

    static async void OnRequest(WebKit.URISchemeRequest request)
    {
        PageResponse page;
        try
        {
            page = await NoteServer.HandleAsync(request.GetHttpMethod() ?? "GET", new Uri(request.GetUri()),
                () => ReadAll(request.GetHttpBody()));
        }
        catch (Exception ex)
        {
            page = PageResponse.Text(ex.Message, 500);
        }

        // Gir.Core's GLib.Bytes.New throws for an empty buffer (e.g. a save's empty answer, or a 404).
        var body = page.Body.Length == 0 ? Gio.MemoryInputStream.New() : Gio.MemoryInputStream.NewFromBytes(GLib.Bytes.New(page.Body));
        var response = WebKit.URISchemeResponse.New(body, page.Body.Length);
        response.SetStatus((uint)page.Status, page.Status == 200 ? "OK" : "Error");
        response.SetContentType(page.ContentType);
        var headers = Soup.MessageHeaders.New(Soup.MessageHeadersType.Response);
        headers.Append("Cache-Control", "no-store");
        response.SetHttpHeaders(headers);
        request.FinishWithResponse(response);
    }

    static byte[] ReadAll(Gio.InputStream? stream)
    {
        if (stream is null) return [];
        using var ms = new MemoryStream();
        var buffer = new byte[64 * 1024];
        while (true)
        {
            var read = (int)stream.Read(buffer, null);
            if (read <= 0) break;
            ms.Write(buffer, 0, read);
        }
        return ms.ToArray();
    }
}
