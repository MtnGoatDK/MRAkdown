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
/// A very large folder (such as a home folder) is scanned partly: only its top level and the folders opened in the
/// page (see <see cref="IsPartial"/>).
/// </summary>
sealed class NoteIndex
{
    /// <param name="Children">A folder's contents; null for a file.</param>
    /// <param name="Unscanned">A folder in a partial index whose contents haven't been scanned yet.</param>
    public record Node(string Name, string Path, List<Node>? Children, bool? Unscanned = null);

    /// <summary>Result of one folder scan. Immutable once built, so it can be swapped in atomically.</summary>
    sealed class Snapshot
    {
        public Node Tree = new("", "", []);
        // Only some folders were scanned (see IsPartial).
        public bool Partial;
        // Note name (no extension) -> relative path, e.g. "Ideas" -> "projects/Ideas.md"
        public readonly Dictionary<string, string> NotesByName = new(StringComparer.OrdinalIgnoreCase);
        // Relative path without extension -> relative path, e.g. "projects/Ideas" -> "projects/Ideas.md"
        public readonly Dictionary<string, string> NotesByPath = new(StringComparer.OrdinalIgnoreCase);
        // Any file name -> relative path, used for embeds like ![[diagram.png]]
        public readonly Dictionary<string, string> FilesByName = new(StringComparer.OrdinalIgnoreCase);
    }

    public const string NoteDirKey = "noteDir";

    // A folder with more files and subfolders than this (hidden ones not counted) is scanned partly.
    const int FullScanLimit = 50_000;

    /// <summary>Thrown inside a full scan that went over <see cref="FullScanLimit"/>.</summary>
    sealed class ScanLimitReachedException : Exception;

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
    readonly Task<Snapshot> _firstScan;
    // In a partial index: the folders that are scanned ("" is the root). Only changed on the UI thread.
    readonly HashSet<string> _openFolders = [""];

    public string Root { get; }

    /// <summary>Short stable id used in URLs, so tabs from different folders can share one page.</summary>
    public string Id { get; }

    public string Name => Path.GetFileName(Root) is { Length: > 0 } name ? name : Root;

    /// <summary>False until the first folder scan has completed.</summary>
    public bool IsIndexed => _snapshot is not null;

    /// <summary>Completes when the first folder scan has; after that, <see cref="IsPartial"/> is known.</summary>
    public Task FirstScan => _firstScan;

    /// <summary>
    /// True for a folder too large to scan in full: only its top level and the folders opened in the page
    /// (<see cref="OpenFolders"/>) are scanned. Links and search then only find files in those.
    /// </summary>
    public bool IsPartial => _firstScan.IsCompletedSuccessfully && _firstScan.Result.Partial;

    /// <summary>In a partial index, the folders that are scanned (relative paths; "" is the root).</summary>
    public IReadOnlyCollection<string> OpenFolders => _openFolders;

    /// <summary>Raised on the UI thread when a partial index starts scanning another folder.</summary>
    public event Action<string>? FolderOpened;

    public NoteIndex(string root, string id)
    {
        Root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        Id = id;
        _pipeline = new MarkdownPipelineBuilder()
            .UseAdvancedExtensions()
            .UseYamlFrontMatter()
            .Use(new WikiLinkExtension(this))
            .Build();
        _scan = _firstScan = Task.Run(() => Scan(FullScanLimit, null));
        _ = PublishAsync(_scan);
    }

    /// <summary>Rescans the folder; the previous snapshot stays in use until the new one is ready.</summary>
    public Task Rebuild()
    {
        var openFolders = IsPartial ? _openFolders.ToList() : null;
        _scan = Task.Run(() => Scan(int.MaxValue, openFolders));
        return PublishAsync(_scan);
    }

    /// <summary>
    /// In a partial index, also scans these folders (and the folders they are in), so the tree shows their contents.
    /// Completes when the tree includes them. Does nothing for a fully scanned folder.
    /// </summary>
    public async Task OpenFoldersAsync(IEnumerable<string> folders)
    {
        await _firstScan;
        if (!IsPartial) return;
        var added = false;
        foreach (var folder in folders)
        {
            var parts = folder.Split('/', StringSplitOptions.RemoveEmptyEntries);
            for (var i = 1; i <= parts.Length; i++)
            {
                var rel = string.Join('/', parts[..i]);
                if (_openFolders.Contains(rel) || FullPath(rel) is not { } full || !Directory.Exists(full)) continue;
                _openFolders.Add(rel);
                FolderOpened?.Invoke(rel);
                added = true;
            }
        }
        if (added) await Rebuild();
        else await _scan;
    }

    async Task PublishAsync(Task<Snapshot> scan)
    {
        var snapshot = await scan;
        // A newer scan may have started meanwhile; only the latest one wins.
        if (scan == _scan) _snapshot = snapshot;
    }

    /// <summary>
    /// The folder tree with only the files <paramref name="showFile"/> accepts, leaving out folders that end up
    /// empty. In a partial index every folder stays: it may have unscanned contents, or the user just opened it.
    /// </summary>
    public async Task<string> TreeJsonAsync(Func<string, bool> showFile)
    {
        var snapshot = await _scan;
        return JsonSerializer.Serialize(Filter(snapshot.Tree, showFile, keepFolders: snapshot.Partial), Json);
    }

    static Node Filter(Node folder, Func<string, bool> showFile, bool keepFolders)
    {
        var children = new List<Node>();
        foreach (var child in folder.Children!)
        {
            if (child.Children is null)
            {
                if (showFile(child.Path)) children.Add(child);
            }
            else if (Filter(child, showFile, keepFolders) is var shown && (keepFolders || shown.Children!.Count > 0))
            {
                children.Add(shown);
            }
        }
        return folder with { Children = children };
    }

    public static bool IsMarkdown(string path) =>
        path.EndsWith(".md", StringComparison.OrdinalIgnoreCase) ||
        path.EndsWith(".markdown", StringComparison.OrdinalIgnoreCase);

    /// <param name="limit">Most files and folders to scan in full; above it, scan partly instead.</param>
    /// <param name="openFolders">The folders to scan, for a partial scan; null for a full one.</param>
    Snapshot Scan(int limit, List<string>? openFolders)
    {
        if (openFolders is null)
        {
            var full = new Snapshot();
            var budget = limit;
            try
            {
                full.Tree = Walk(Root, full, ref budget, null) ?? new Node(Path.GetFileName(Root), "", []);
                return full;
            }
            catch (ScanLimitReachedException)
            {
                openFolders = [""];
            }
        }

        var partial = new Snapshot { Partial = true };
        var unlimited = int.MaxValue;
        partial.Tree = Walk(Root, partial, ref unlimited, openFolders.ToHashSet())
            ?? new Node(Path.GetFileName(Root), "", []);
        return partial;
    }

    /// <param name="budget">Files and folders left to scan; throws <see cref="ScanLimitReachedException"/> past 0.</param>
    /// <param name="openFolders">For a partial scan, the folders to scan; the others are listed as unscanned.</param>
    Node? Walk(string dir, Snapshot s, ref int budget, HashSet<string>? openFolders)
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
        budget -= subdirs.Length + files.Length;
        if (budget < 0) throw new ScanLimitReachedException();

        // Index files before descending so shallower notes win name collisions, like Obsidian.
        // The tree lists every file except hidden ones; TreeJsonAsync picks the kinds the page asks for.
        var fileNodes = new List<Node>();
        foreach (var f in files.OrderBy(Path.GetFileName, StringComparer.OrdinalIgnoreCase))
        {
            var rel = Rel(f);
            var fileName = Path.GetFileName(f);
            s.FilesByName.TryAdd(fileName, rel);
            if (!IsMarkdown(f))
            {
                if (!fileName.StartsWith('.')) fileNodes.Add(new Node(fileName, rel, null));
                continue;
            }
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
            // Don't follow links to folders (symlinks, junctions): they can point back up, like the links to "/" in
            // Wine and Proton game prefixes, and the scan would never end.
            if (new DirectoryInfo(d).LinkTarget is not null) continue;
            if (openFolders is not null && !openFolders.Contains(Rel(d)))
                dirNodes.Add(new Node(name, Rel(d), [], Unscanned: true));
            else if (Walk(d, s, ref budget, openFolders) is { } node)
                dirNodes.Add(node);
        }

        // Leave out empty folders; TreeJsonAsync also leaves out folders with none of the files asked for.
        if (fileNodes.Count == 0 && dirNodes.Count == 0 && dir != Root && openFolders is null) return null;
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
            if (FullPath(target) is { } f && File.Exists(f)) return target;
            // A partial index hasn't seen every folder: look next to the note too.
            if (!s.Partial) return null;
        }

        // Index still loading (or partial): check the note's own folder and the root directly.
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
            ?? throw new InvalidDataException("Invalid file path.");
        Directory.CreateDirectory(dir);

        var stem = Path.GetFileNameWithoutExtension(name);
        var ext = Path.GetExtension(name);
        var target = Path.Combine(dir, name);
        for (var i = 1; File.Exists(target); i++) target = Path.Combine(dir, $"{stem} {i}{ext}");
        File.WriteAllBytes(target, data);
        return "attachments/" + Uri.EscapeDataString(Path.GetFileName(target));
    }

    /// <summary>
    /// Saves text as a copy next to a file ("Name (copy).md", "Name (copy 2).md", ...), in the file's encoding, and
    /// returns the copy's path: your version, when the file was changed on disk while you edited it.
    /// </summary>
    public string SaveCopy(string rel, string text)
    {
        var full = ExistingFile(rel);
        var dir = Path.GetDirectoryName(full)!;
        var stem = Path.GetFileNameWithoutExtension(full);
        var ext = Path.GetExtension(full);
        var target = Path.Combine(dir, $"{stem} (copy){ext}");
        for (var n = 2; File.Exists(target); n++) target = Path.Combine(dir, $"{stem} (copy {n}){ext}");
        File.Copy(full, target); // so the copy is written in the file's encoding (TextFiles.Write keeps it)
        TextFiles.Write(target, text);
        return Rel(target);
    }

    /// <summary>A large text file's line index, for reading it in parts (see <see cref="BigTextFile"/>).</summary>
    public string BigTextIndex(string rel) => BigTextFile.IndexJson(ExistingFile(rel));

    /// <summary>Lines of a large text file (0-based from, up to count of them).</summary>
    public string BigTextLines(string rel, long from, int count) => BigTextFile.Lines(ExistingFile(rel), from, count);

    /// <summary>Overwrites a file, keeping its encoding (see <see cref="TextFiles"/>).</summary>
    public void Save(string rel, string text) => TextFiles.Write(ExistingFile(rel), text);

    /// <summary>
    /// Renames a file within its folder and returns its new relative path. <paramref name="name"/> is the new file
    /// name; a Markdown file named without an extension keeps its own (as its title shows no ".md"). Fails if the
    /// name isn't a valid file name or another file or folder there has it; changing only the case is allowed.
    /// </summary>
    public string Rename(string rel, string name)
    {
        var full = ExistingFile(rel);
        name = name.Trim();
        if (name.Length == 0 || name.EndsWith('.') || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0
            || name.Contains('/') || name.Contains('\\'))
            throw new InvalidDataException($"\"{name}\" isn't a valid file name.");
        if (IsMarkdown(full) && !IsMarkdown(name)) name += Path.GetExtension(full);

        var target = Path.Combine(Path.GetDirectoryName(full)!, name);
        if (string.Equals(target, full, StringComparison.Ordinal)) return rel;
        if (string.Equals(target, full, PathComparison))
        {
            // Only the case changes: on Windows that's the same file, so move it through a temporary name
            var temp = full + ".renaming";
            File.Move(full, temp);
            File.Move(temp, target);
        }
        else
        {
            if (File.Exists(target) || Directory.Exists(target))
                throw new InvalidDataException($"There's already a file named \"{name}\" in this folder.");
            File.Move(full, target);
        }
        return Rel(target);
    }

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
            var size = new FileInfo(full).Length;
            if (text is null && size > TextFiles.MaxSize)
            {
                // Too large to load whole: a text file is read in parts, as the page shows them (see BigTextFile)
                var head = new byte[64 * 1024];
                using (var file = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                    head = head[..file.Read(head)];
                if (TextFiles.IsBinary(head))
                    return JsonSerializer.Serialize(new { path = rel, title = name, markdown = false, binary = true }, Json);
                if (!BigTextFile.CanShow(full))
                    return JsonSerializer.Serialize(new { path = rel, title = name, markdown = false, tooLarge = true }, Json);
                return JsonSerializer.Serialize(new { path = rel, title = name, markdown = false, big = true, size }, Json);
            }
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
