using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;

namespace MRAkdown;

/// <summary>Reads a file's history and earlier versions from git, for comparing with the file now.</summary>
static partial class GitFiles
{
    /// <summary>Thrown with a message for people when git can't give what was asked for.</summary>
    public sealed class GitException(string message) : Exception(message);

    /// <param name="Path">The file's path in the repository at that commit (it may have been renamed since).</param>
    public sealed record Commit(string Hash, string Short, string Date, string Author, string Subject, string Path);

    // Most commits listed for a file.
    const int MaxCommits = 200;

    [GeneratedRegex("^[0-9a-f]{4,64}$")]
    private static partial Regex CommitHash();

    /// <summary>The file as in git's last commit (HEAD).</summary>
    public static Task<string> ReadHeadAsync(string file) =>
        // "HEAD:./name": the file in whichever repository holds its folder.
        ReadBlobAsync(file, "HEAD:./" + Path.GetFileName(file));

    /// <summary>The file as in a given commit, where it had the given path in the repository (from <see cref="LogAsync"/>).</summary>
    public static Task<string> ReadAtAsync(string file, string commit, string repoPath)
    {
        if (!CommitHash().IsMatch(commit)) throw new GitException("That isn't a commit.");
        return ReadBlobAsync(file, $"{commit}:{repoPath}");
    }

    static async Task<string> ReadBlobAsync(string file, string blob)
    {
        var (exitCode, output, error) = await RunAsync(file, "cat-file", "blob", blob);
        if (exitCode != 0) throw new GitException(Explain(error));
        if (TextFiles.IsBinary(output)) throw new GitException("That version isn't a text file.");
        return TextFiles.Decode(output);
    }

    /// <summary>The commits that changed the file, newest first, following it through renames.</summary>
    public static async Task<List<Commit>> LogAsync(string file)
    {
        // Each commit: a record separator, its fields split by unit separators, then (from --name-only) its path.
        var (exitCode, output, error) = await RunAsync(file, "-c", "core.quotepath=false", "log", "--follow",
            $"--max-count={MaxCommits}", "--format=%x1e%H%x1f%h%x1f%as%x1f%an%x1f%s", "--name-only", "--", "./" + Path.GetFileName(file));
        if (exitCode != 0) throw new GitException(Explain(error));

        var commits = new List<Commit>();
        foreach (var record in Encoding.UTF8.GetString(output).Split('\x1e', StringSplitOptions.RemoveEmptyEntries))
        {
            var lines = record.Split('\n');
            var fields = lines[0].Split('\x1f');
            var path = lines.Skip(1).FirstOrDefault(l => l.Trim().Length > 0)?.Trim();
            if (fields.Length < 5 || path is null) continue;
            commits.Add(new Commit(fields[0], fields[1], fields[2], fields[3], fields[4], path));
        }
        return commits;
    }

    /// <summary>Runs git in the file's folder; returns its exit code, output and error text.</summary>
    static async Task<(int ExitCode, byte[] Output, string Error)> RunAsync(string file, params string[] args)
    {
        var start = new ProcessStartInfo("git")
        {
            WorkingDirectory = Path.GetDirectoryName(file)!,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var arg in args) start.ArgumentList.Add(arg);

        Process process;
        try
        {
            process = Process.Start(start) ?? throw new GitException("Git couldn't be started.");
        }
        catch (Win32Exception)
        {
            throw new GitException("Git isn't installed, or isn't on the PATH.");
        }

        using (process)
        {
            using var output = new MemoryStream();
            var readOutput = process.StandardOutput.BaseStream.CopyToAsync(output);
            var readError = process.StandardError.ReadToEndAsync();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            try
            {
                await process.WaitForExitAsync(timeout.Token);
            }
            catch (OperationCanceledException)
            {
                process.Kill(entireProcessTree: true);
                throw new GitException("Git took too long to answer.");
            }
            await readOutput;
            return (process.ExitCode, output.ToArray(), await readError);
        }
    }

    /// <summary>Git's error, in words that say what it means for this comparison.</summary>
    static string Explain(string error)
    {
        if (error.Contains("not a git repository", StringComparison.OrdinalIgnoreCase))
            return "This file isn't in a git repository.";
        if (error.Contains("exists on disk, but not in", StringComparison.OrdinalIgnoreCase)
            || error.Contains("does not exist in", StringComparison.OrdinalIgnoreCase))
            return "This file isn't in that commit (it may not be committed yet).";
        if (error.Contains("invalid object name 'HEAD'", StringComparison.OrdinalIgnoreCase)
            || error.Contains("Not a valid object name HEAD", StringComparison.OrdinalIgnoreCase)
            || error.Contains("does not have any commits yet", StringComparison.OrdinalIgnoreCase))
            return "The repository has no commits yet.";
        if (error.Contains("dubious ownership", StringComparison.OrdinalIgnoreCase))
            return "Git doesn't trust this repository's folder (it belongs to another user). " + error.Trim();
        return error.Trim() is { Length: > 0 } message ? message : "Git couldn't read that version.";
    }
}
