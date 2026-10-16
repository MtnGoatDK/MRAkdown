using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Web;

namespace MRAkdown;

/// <summary>A response for the page, which each host hands to its browser engine.</summary>
sealed record PageResponse(int Status, string ContentType, byte[] Body)
{
    public static PageResponse Ok(byte[] body, string contentType) => new(200, contentType, body);
    public static PageResponse Text(string text, int status = 200) => new(status, "text/plain", Encoding.UTF8.GetBytes(text));
    public static PageResponse Json(string json) => new(200, "application/json", Encoding.UTF8.GetBytes(json));
    public static readonly PageResponse NotFound = new(404, "text/plain", []);
}

/// <summary>
/// Serves the page and notes. The app page is at /, its files under /__app/, the note API under /__api/,
/// and the files of each open folder under /f/{root id}/... (see <see cref="Roots"/>).
/// Must be used from the UI thread.
/// </summary>
static class NoteServer
{
    /// <param name="readBody">Reads the request body; only called for requests that have one.</param>
    public static async Task<PageResponse> HandleAsync(string method, Uri uri, Func<byte[]> readBody)
    {
        var path = Uri.UnescapeDataString(uri.AbsolutePath);
        var query = HttpUtility.ParseQueryString(uri.Query);
        try
        {
            if (path == "/__api/tree" && Roots.Find(query["r"]) is { } treeRoot)
                return PageResponse.Json(await treeRoot.TreeJsonAsync());
            if (path == "/")
                return PageResponse.Ok(ReadResource("app.html"), "text/html");
            if (path.StartsWith("/__app/"))
                return PageResponse.Ok(ReadResource(path["/__app/".Length..]), MimeType(path));
            if (path.StartsWith("/__api/") && Roots.Find(query["r"]) is { } root)
                return HandleApi(path, root, query["n"] ?? "", method == "POST", query, readBody);
            if (ResolveFileUrl(path) is { } full && File.Exists(full))
                // Read into memory so we never hold a lock on the user's files.
                return PageResponse.Ok(File.ReadAllBytes(full), MimeType(full));
            return PageResponse.NotFound;
        }
        catch (FileNotFoundException)
        {
            return PageResponse.NotFound;
        }
        catch (Exception ex)
        {
            return PageResponse.Text(ex.Message, 500);
        }
    }

    static PageResponse HandleApi(string path, NoteIndex index, string note, bool isPost,
        System.Collections.Specialized.NameValueCollection query, Func<byte[]> readBody)
    {
        return (path, isPost) switch
        {
            ("/__api/note", false) => PageResponse.Json(index.RenderJson(note)),
            ("/__api/source", false) => PageResponse.Text(index.ReadSource(note)),
            ("/__api/render", true) => PageResponse.Json(index.RenderJson(note, BodyText())),
            ("/__api/save", true) => SaveNote(),
            ("/__api/upload", true) => PageResponse.Json(JsonSerializer.Serialize(new
            {
                link = index.SaveAttachment(note, query["name"] ?? "image.png", readBody()),
            })),
            _ => PageResponse.NotFound,
        };

        string BodyText() => Encoding.UTF8.GetString(readBody());

        PageResponse SaveNote()
        {
            index.Save(note, BodyText());
            return PageResponse.Text("");
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
}
