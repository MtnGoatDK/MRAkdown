using System.Runtime.InteropServices;
using static MRAkdown.ObjC;

namespace MRAkdown;

/// <summary>
/// WebKit setup shared by all windows: the page and notes are served by <see cref="NoteServer"/> under a custom
/// URL scheme (mrakdown://notes/...), through a WKURLSchemeHandler.
/// </summary>
static class WebHost
{
    public const string Scheme = "mrakdown";
    public const string Origin = Scheme + "://notes";

    static IntPtr s_handler;
    // Requests being answered. WebKit may stop one first (e.g. the page went away), and then it must not be answered.
    static readonly HashSet<IntPtr> s_running = [];

    /// <summary>A new WKWebViewConfiguration that serves the scheme, owned by the caller.</summary>
    public static unsafe IntPtr CreateConfiguration()
    {
        if (s_handler == 0)
        {
            var cls = DefineClass("MRAkdownSchemeHandler", "NSObject", ["WKURLSchemeHandler"],
                ("webView:startURLSchemeTask:", (IntPtr)(delegate* unmanaged<IntPtr, IntPtr, IntPtr, IntPtr, void>)&Start, "v@:@@"),
                ("webView:stopURLSchemeTask:", (IntPtr)(delegate* unmanaged<IntPtr, IntPtr, IntPtr, IntPtr, void>)&Stop, "v@:@@"));
            s_handler = Send(Send(cls, "alloc"), "init");
        }
        var config = New("WKWebViewConfiguration");
        Send(config, "setURLSchemeHandler:forURLScheme:", s_handler, NSString(Scheme));
        return config;
    }

    [UnmanagedCallersOnly]
    static void Start(IntPtr self, IntPtr sel, IntPtr webView, IntPtr task) => Callback(() =>
    {
        Send(task, "retain");
        s_running.Add(task);
        _ = HandleAsync(task);
    });

    [UnmanagedCallersOnly]
    static void Stop(IntPtr self, IntPtr sel, IntPtr webView, IntPtr task) => Callback(() => s_running.Remove(task));

    static async Task HandleAsync(IntPtr task)
    {
        try
        {
            var request = Send(task, "request");
            var url = FromNSString(Send(Send(request, "URL"), "absoluteString")) ?? "";
            PageResponse page;
            try
            {
                page = await NoteServer.HandleAsync(FromNSString(Send(request, "HTTPMethod")) ?? "GET", new Uri(url),
                    () => ReadBody(request));
            }
            catch (Exception ex)
            {
                page = PageResponse.Text(ex.Message, 500);
            }
            if (s_running.Remove(task)) Respond(task, request, page);
        }
        finally
        {
            Send(task, "release");
        }
    }

    static unsafe void Respond(IntPtr task, IntPtr request, PageResponse page)
    {
        var keys = stackalloc IntPtr[] { NSString("Content-Type"), NSString("Cache-Control") };
        var values = stackalloc IntPtr[] { NSString(page.ContentType), NSString("no-store") };
        var headers = Send(Class("NSDictionary"), "dictionaryWithObjects:forKeys:count:", (IntPtr)values, (IntPtr)keys, 2);
        var response = Send(Send(Class("NSHTTPURLResponse"), "alloc"), "initWithURL:statusCode:HTTPVersion:headerFields:",
            Send(request, "URL"), page.Status, NSString("HTTP/1.1"), headers);
        Send(task, "didReceiveResponse:", response);
        Send(response, "release");
        if (page.Body.Length > 0) Send(task, "didReceiveData:", NSData(page.Body));
        Send(task, "didFinish");
    }

    /// <summary>A request's body: WebKit gives it as data, or as a stream for a large one.</summary>
    static unsafe byte[] ReadBody(IntPtr request)
    {
        if (Send(request, "HTTPBody") is var data && data != 0) return FromNSData(data);
        var stream = Send(request, "HTTPBodyStream");
        if (stream == 0) return [];
        using var ms = new MemoryStream();
        var buffer = new byte[64 * 1024];
        Send(stream, "open");
        fixed (byte* p = buffer)
        {
            while (true)
            {
                var read = (int)Send(stream, "read:maxLength:", (IntPtr)p, buffer.Length);
                if (read <= 0) break;
                ms.Write(buffer, 0, read);
            }
        }
        Send(stream, "close");
        return ms.ToArray();
    }
}
