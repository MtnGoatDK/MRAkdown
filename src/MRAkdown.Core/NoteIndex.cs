using System.Text.Json;
using System.Text.Json.Serialization;
using Markdig;
using Markdig.Renderers;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;

namespace MRAkdown;

/// <summary>
/// Indexes the Markdown files under a root folder and renders notes to HTML,
/// resolving [[wikilinks]] and relative links against that root.
/// The folder scan runs in the background so a note can be shown before it finishes.
/// </summary>
sealed class NoteIndex
{
    public record Node(string Name, string Path, List<Node>? Children);

    /// <summary>Result of one folder scan. Immutable once built, so it can be swapped in atomically.</summary>
    sealed class Snapshot
    {
        public Node Tree = new("", "", []);
        // Note name (no extension) -> relative path, e.g. "Ideas" -> "projects/Ideas.md"
        public readonly Dictionary<string, string> NotesByName = new(StringComparer.OrdinalIgnoreCase);
        // Relative path without extension -> relative path, e.g. "projects/Ideas" -> "projects/Ideas.md"
        public readonly Dictionary<string, string> NotesByPath = new(StringComparer.OrdinalIgnoreCase);
        // Any file name -> relative path, used for embeds like ![[diagram.png]]
        public readonly Dictionary<string, string> FilesByName = new(StringComparer.OrdinalIgnoreCase);
    }

    public const string NoteDirKey = "noteDir";

    /// <summary>How file system paths compare: ignoring case on Windows, exactly elsewhere.</summary>
    public static readonly StringComparison PathComparison =
        OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    readonly MarkdownPipeline _pipeline;
    // Only read and written on the UI thread; the scan itself runs on the thread pool.
    Snapshot? _snapshot;
    Task<Snapshot> _scan;

    public string Root { get; }

    /// <summary>Short stable id used in URLs, so tabs from different folders can share one page.</summary>
    public string Id { get; }

    public string Name => Path.GetFileName(Root) is { Length: > 0 } name ? name : Root;

    /// <summary>False until the first folder scan has completed.</summary>
    public bool IsIndexed => _snapshot is not null;

    public NoteIndex(string root, string id)
    {
        Root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        Id = id;
        _pipeline = new MarkdownPipelineBuilder()
            .UseAdvancedExtensions()
            .UseYamlFrontMatter()
            .Use(new WikiLinkExtension(this))
            .Build();
        _scan = Task.Run(Scan);
        _ = PublishAsync(_scan);
    }

    /// <summary>Rescans the folder; the previous snapshot stays in use until the new one is ready.</summary>
    public Task Rebuild()
    {
        _scan = Task.Run(Scan);
        return PublishAsync(_scan);
    }

    async Task PublishAsync(Task<Snapshot> scan)
    {
        var snapshot = await scan;
        // A newer scan may have started meanwhile; only the latest one wins.
        if (scan == _scan) _snapshot = snapshot;
    }

    public async Task<string> TreeJsonAsync() => JsonSerializer.Serialize((await _scan).Tree, Json);

    public static bool IsMarkdown(string path) =>
        path.EndsWith(".md", StringComparison.OrdinalIgnoreCase) ||
        path.EndsWith(".markdown", StringComparison.OrdinalIgnoreCase);

    Snapshot Scan()
    {
        var snapshot = new Snapshot();
        snapshot.Tree = Walk(Root, snapshot) ?? new Node(Path.GetFileName(Root), "", []);
        return snapshot;
    }

    Node? Walk(string dir, Snapshot s)
    {
        string[] subdirs, files;
        try
        {
            subdirs = Directory.GetDirectories(dir);
            files = Directory.GetFiles(dir);
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
        {
            return null;
        }

        // Index files before descending so shallower notes win name collisions, like Obsidian.
        var fileNodes = new List<Node>();
        foreach (var f in files.OrderBy(Path.GetFileName, StringComparer.OrdinalIgnoreCase))
        {
            var rel = Rel(f);
            s.FilesByName.TryAdd(Path.GetFileName(f), rel);
            if (!IsMarkdown(f)) continue;
            var name = Path.GetFileNameWithoutExtension(f);
            s.NotesByName.TryAdd(name, rel);
            s.NotesByPath.TryAdd(StripExtension(rel), rel);
            fileNodes.Add(new Node(name, rel, null));
        }

        var dirNodes = new List<Node>();
        foreach (var d in subdirs.OrderBy(Path.GetFileName, StringComparer.OrdinalIgnoreCase))
        {
            var name = Path.GetFileName(d);
            if (name.StartsWith('.') || name.Equals("node_modules", StringComparison.OrdinalIgnoreCase)) continue;
            if (Walk(d, s) is { } node) dirNodes.Add(node);
        }

        // Hide folders that contain no notes.
        if (fileNodes.Count == 0 && dirNodes.Count == 0 && dir != Root) return null;
        return new Node(Path.GetFileName(dir), Rel(dir), [.. dirNodes, .. fileNodes]);
    }

    public string Rel(string fullPath)
    {
        var rel = Path.GetRelativePath(Root, fullPath).Replace('\\', '/');
        return rel == "." ? "" : rel;
    }

    static string StripExtension(string path) =>
        IsMarkdown(path) ? path[..path.LastIndexOf('.')] : path;

    /// <summary>Maps a relative path to a full path, or null if it escapes the root.</summary>
    public string? FullPath(string rel)
    {
        var full = Path.GetFullPath(Path.Combine(Root, rel.TrimStart('/', '\\')));
        return full.StartsWith(Root + Path.DirectorySeparatorChar, PathComparison) ? full : null;
    }

    /// <summary>
    /// Resolves a wikilink target ("Note", "folder/Note", "image.png") to a relative path.
    /// <paramref name="noteDir"/> is the linking note's folder, used while the index is still loading.
    /// </summary>
    public string? Resolve(string target, string noteDir)
    {
        target = target.Trim().Replace('\\', '/').TrimStart('/');
        if (target.Length == 0) return null;

        if (_snapshot is { } s)
        {
            var noExt = StripExtension(target);
            if (s.NotesByPath.TryGetValue(noExt, out var rel)) return rel;
            if (s.NotesByName.TryGetValue(noExt[(noExt.LastIndexOf('/') + 1)..], out rel)) return rel;
            if (s.FilesByName.TryGetValue(Path.GetFileName(target), out rel)) return rel;
            return FullPath(target) is { } f && File.Exists(f) ? target : null;
        }

        // Index still loading: check the note's own folder and the root directly.
        foreach (var dir in noteDir.Length > 0 ? new[] { noteDir, "" } : new[] { "" })
        {
            var candidate = dir.Length > 0 ? dir + "/" + target : target;
            foreach (var path in IsMarkdown(candidate) ? new[] { candidate } : new[] { candidate + ".md", candidate })
            {
                if (FullPath(path) is { } full && File.Exists(full)) return Rel(full);
            }
        }
        return null;
    }

    /// <summary>URL the page uses for a file in this folder: /f/{root id}/{relative path}.</summary>
    public string ToUrl(string rel) =>
        $"/f/{Id}/" + string.Join("/", rel.Split('/').Select(Uri.EscapeDataString));

    /// <summary>Full path of an existing file under the root (a note or any other file opened as text).</summary>
    string ExistingFile(string rel) =>
        FullPath(rel) is { } full && File.Exists(full) ? full : throw new FileNotFoundException(rel);

    /// <summary>A file's text for the editor; rejects files that aren't text or are too large to edit.</summary>
    public string ReadSource(string rel)
    {
        var full = ExistingFile(rel);
        if (new FileInfo(full).Length > TextFiles.MaxSize) throw new InvalidDataException("This file is too large to open.");
        var bytes = File.ReadAllBytes(full);
        if (TextFiles.IsBinary(bytes)) throw new InvalidDataException("This file isn't text.");
        return TextFiles.Decode(bytes);
    }

    public static readonly HashSet<string> ImageExtensions = new(StringComparer.OrdinalIgnoreCase)
        { ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif" };

    /// <summary>
    /// Saves an image into an "attachments" folder next to a note, never overwriting an existing file.
    /// Returns the link to use in that note, relative to its folder.
    /// </summary>
    public string SaveAttachment(string noteRel, string fileName, byte[] data)
    {
        ExistingFile(noteRel);
        var name = Path.GetFileName(fileName);
        foreach (var c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
        if (!ImageExtensions.Contains(Path.GetExtension(name)))
            throw new InvalidDataException("Only image files can be inserted.");

        var noteDir = Path.GetDirectoryName(noteRel)?.Replace('\\', '/') ?? "";
        var dir = FullPath(noteDir.Length > 0 ? noteDir + "/attachments" : "attachments")
            ?? throw new InvalidDataException("Invalid note path.");
        Directory.CreateDirectory(dir);

        var stem = Path.GetFileNameWithoutExtension(name);
        var ext = Path.GetExtension(name);
        var target = Path.Combine(dir, name);
        for (var i = 1; File.Exists(target); i++) target = Path.Combine(dir, $"{stem} {i}{ext}");
        File.WriteAllBytes(target, data);
        return "attachments/" + Uri.EscapeDataString(Path.GetFileName(target));
    }

    /// <summary>Overwrites a file, keeping its encoding (see <see cref="TextFiles"/>).</summary>
    public void Save(string rel, string text) => TextFiles.Write(ExistingFile(rel), text);

    /// <summary>
    /// A note rendered to HTML, or for any other file its plain text ({ markdown: false, text }),
    /// or a flag if it isn't text ({ binary: true }) or is too large ({ tooLarge: true }).
    /// </summary>
    /// <param name="rel">The file; empty for a new note that hasn't been saved yet (links resolve from the root).</param>
    /// <param name="text">Unsaved editor text to render instead of the file on disk.</param>
    public string RenderJson(string rel, string? text = null)
    {
        var isDraft = rel.Length == 0 && text is not null;
        var full = isDraft ? null : ExistingFile(rel);

        if (full is not null && !IsMarkdown(full))
        {
            var name = Path.GetFileName(full);
            if (text is null && new FileInfo(full).Length > TextFiles.MaxSize)
                return JsonSerializer.Serialize(new { path = rel, title = name, markdown = false, tooLarge = true }, Json);
            var bytes = text is null ? File.ReadAllBytes(full) : null;
            if (bytes is not null && TextFiles.IsBinary(bytes))
                return JsonSerializer.Serialize(new { path = rel, title = name, markdown = false, binary = true }, Json);
            return JsonSerializer.Serialize(new
            {
                path = rel,
                title = name,
                markdown = false,
                text = text ?? TextFiles.Decode(bytes!),
                indexed = true,
            }, Json);
        }

        var dir = Path.GetDirectoryName(rel)?.Replace('\\', '/') ?? "";
        var context = new MarkdownParserContext();
        context.Properties[NoteDirKey] = dir;
        var doc = Markdown.Parse(text ?? TextFiles.Read(full!), _pipeline, context);
        foreach (var link in doc.Descendants<LinkInline>())
        {
            if (link.Url is { } url) link.Url = RewriteRelativeUrl(dir, url);
        }

        using var writer = new StringWriter();
        var renderer = new HtmlRenderer(writer);
        _pipeline.Setup(renderer);
        renderer.Render(doc);

        return JsonSerializer.Serialize(new
        {
            path = rel,
            title = isDraft ? "Untitled" : Path.GetFileNameWithoutExtension(rel),
            html = writer.ToString(),
            indexed = IsIndexed,
        }, Json);
    }

    /// <summary>Turns links relative to the note's folder (or "/..." relative to the root) into page URLs.</summary>
    string RewriteRelativeUrl(string noteDir, string url)
    {
        if (url.StartsWith('#') || url.StartsWith("//") || Uri.TryCreate(url, UriKind.Absolute, out _)) return url;
        if (url.StartsWith('/'))
        {
            noteDir = "";
            url = url.TrimStart('/');
        }

        var hashAt = url.IndexOf('#');
        var fragment = hashAt >= 0 ? url[hashAt..] : "";
        var pathPart = Uri.UnescapeDataString(hashAt >= 0 ? url[..hashAt] : url);
        if (pathPart.Length == 0) return url;

        var full = FullPath(Path.Combine(noteDir, pathPart));
        string? rel = full is not null && File.Exists(full) ? Rel(full) : Resolve(pathPart, noteDir);
        return rel is null ? url : ToUrl(rel) + fragment;
    }
}
