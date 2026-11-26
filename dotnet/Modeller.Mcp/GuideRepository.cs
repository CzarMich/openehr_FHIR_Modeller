using System.Text;
using System.Text.RegularExpressions;
using ModelContextProtocol.Protocol;

namespace Modeller.Mcp;

public sealed class GuideRepository
{
    public static readonly string[] Categories = ["archetypes", "templates", "aql", "simplified_formats", "specs", "howto"];
    private readonly Dictionary<string, TextResourceContents> contents = new(StringComparer.Ordinal);
    private readonly List<Resource> resources = [];
    public IReadOnlyList<Resource> Resources => resources;

    public GuideRepository(string root)
    {
        var directory = new DirectoryInfo(Path.GetFullPath(root));
        if (!directory.Exists || directory.LinkTarget is not null)
            throw new InvalidOperationException("Bundled guide directory is unavailable.");
        long total = 0;
        foreach (var category in Categories)
        {
            var folder = new DirectoryInfo(Path.Combine(directory.FullName, category));
            if (!folder.Exists || folder.LinkTarget is not null) continue;
            foreach (var file in folder.EnumerateFiles("*.md").OrderBy(f => f.Name, StringComparer.Ordinal))
            {
                if (file.LinkTarget is not null) continue;
                if (file.Length > 1048576 || (total += file.Length) > 33554432)
                    throw new InvalidOperationException("Bundled guides exceed the supported content bound.");
                var name = Path.GetFileNameWithoutExtension(file.Name);
                if (!ValidSegment(name)) continue;
                var bytes = File.ReadAllBytes(file.FullName);
                var text = new UTF8Encoding(false, true).GetString(bytes);
                if (string.IsNullOrWhiteSpace(text)) continue;
                var uri = $"openehr://guides/{category}/{name}";
                contents.Add(uri, new TextResourceContents { Uri = uri, MimeType = "text/markdown", Text = text });
                if (name == "README" || name.StartsWith('_')) continue;
                var title = text.Split('\n', 2)[0].Trim(' ', '#');
                resources.Add(new Resource
                {
                    Uri = uri, Name = Regex.Replace($"guide_{category}_{name}", "[^A-Za-z0-9_-]", "-"),
                    Description = title.Length > 0 ? title : $"Guide {name} for {category}",
                    MimeType = "text/markdown", Size = bytes.LongLength
                });
            }
        }
        if (contents.Count == 0) throw new InvalidOperationException("No bundled guides are available.");
        resources.Sort((a, b) => StringComparer.Ordinal.Compare(a.Uri, b.Uri));
    }

    public TextResourceContents Get(string uri = "", string? category = null, string name = "")
    {
        uri = Trim(uri); category = Trim(category ?? ""); name = Trim(name);
        if (uri.Length > 0)
        {
            var match = Regex.Match(uri, "^openehr://guides/([A-Za-z0-9_-]+)/([A-Za-z0-9_.-]+)$", RegexOptions.CultureInvariant);
            if (!match.Success) throw new GuideLookupException("Invalid guide URI.");
            category = match.Groups[1].Value; name = match.Groups[2].Value;
        }
        if (category.Length == 0 || name.Length == 0)
            throw new GuideLookupException("Guide category and name are required when URI is not provided.");
        if (!ValidSegment(category) || !ValidSegment(name)) throw new GuideLookupException("Invalid guide identifier.");
        var canonical = $"openehr://guides/{category}/{name}";
        return contents.TryGetValue(canonical, out var result) ? result : throw new GuideLookupException("Guide not found within bundled resources.");
    }

    private static string Trim(string value) => value.Trim(' ', '\t', '\n', '\r', '\0', '\v');
    private static bool ValidSegment(string value) => value.Length is > 0 and <= 255 && Regex.IsMatch(value, "^[A-Za-z0-9_.-]+$", RegexOptions.CultureInvariant);
}

public sealed class GuideLookupException(string message) : Exception(message);
