using System.Net;
using Markdig;
using Markdig.Helpers;
using Markdig.Parsers;
using Markdig.Renderers;
using Markdig.Syntax.Inlines;

namespace MRAkdown;

sealed class WikiLinkExtension(NoteIndex index) : IMarkdownExtension
{
    public void Setup(MarkdownPipelineBuilder pipeline)
    {
        // Must run before the standard link parser, which also claims '[' and '!'.
        if (!pipeline.InlineParsers.Contains<WikiLinkParser>())
            pipeline.InlineParsers.Insert(0, new WikiLinkParser(index));
    }

    public void Setup(MarkdownPipeline pipeline, IMarkdownRenderer renderer) { }
}

/// <summary>
/// Parses Obsidian-style links: [[Note]], [[Note|alias]], [[Note#Heading]], [[#Heading]],
/// and embeds ![[image.png]] / ![[image.png|300]].
/// </summary>
sealed class WikiLinkParser : InlineParser
{

    readonly NoteIndex _index;

    public WikiLinkParser(NoteIndex index)
    {
        _index = index;
        OpeningCharacters = ['[', '!'];
    }

    public override bool Match(InlineProcessor processor, ref StringSlice slice)
    {
        var text = slice.Text;
        var embed = slice.CurrentChar == '!';
        var open = slice.Start + (embed ? 1 : 0);
        if (open + 1 > slice.End || text[open] != '[' || text[open + 1] != '[') return false;

        var innerStart = open + 2;
        var close = text.IndexOf("]]", innerStart, slice.End + 1 - innerStart, StringComparison.Ordinal);
        if (close < 0) return false;
        var inner = text[innerStart..close];
        if (inner.Length == 0 || inner.Contains('\n')) return false;

        string target = inner;
        string? alias = null, heading = null;
        var bar = target.IndexOf('|');
        if (bar >= 0) { alias = target[(bar + 1)..].Trim(); target = target[..bar]; }
        var hash = target.IndexOf('#');
        if (hash >= 0) { heading = target[(hash + 1)..].Trim(); target = target[..hash]; }
        target = target.Trim();

        var noteDir = processor.Context?.Properties.GetValueOrDefault(NoteIndex.NoteDirKey) as string ?? "";
        var resolved = target.Length > 0 ? _index.Resolve(target, noteDir) : null;
        string html;

        if (embed && resolved is not null && NoteIndex.ImageExtensions.Contains(Path.GetExtension(resolved)))
        {
            var width = int.TryParse(alias, out var w) ? $" width=\"{w}\"" : "";
            html = $"<img src=\"{Enc(_index.ToUrl(resolved))}\" alt=\"{Enc(target)}\"{width}>";
        }
        else
        {
            var label = alias ?? (heading is null ? target : target.Length == 0 ? heading : $"{target} > {heading}");
            var anchor = heading is null ? "" : "#" + Uri.EscapeDataString(heading);
            var isSameNote = target.Length == 0 && heading is not null;
            var href = isSameNote ? anchor : resolved is null ? "" : _index.ToUrl(resolved) + anchor;
            // Don't fade links before the index is ready; the note is re-rendered once it is.
            var cls = isSameNote || resolved is not null || !_index.IsIndexed ? "internal-link" : "internal-link unresolved";
            html = $"<a class=\"{cls}\" href=\"{Enc(href)}\" data-target=\"{Enc(target)}\">{Enc(label)}</a>";
        }

        processor.Inline = new HtmlInline(html);
        slice.Start = close + 2;
        return true;
    }

    static string Enc(string s) => WebUtility.HtmlEncode(s);
}
