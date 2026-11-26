using System.IO.Compression;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace Modeller.Core;

public static class Sources
{
    public const int Limit = 16777216;
    public static string FileWithin(string root, string relative) {
        if (!Path.IsPathFullyQualified(root) || Path.IsPathFullyQualified(relative) || relative.Contains('\\') || relative.Split('/').Any(p => p is "" or "." or "..")) throw new ProcessingException("SOURCE_PATH_REJECTED");
        var current = Path.GetFullPath(root);
        if (new DirectoryInfo(current).LinkTarget is not null) throw new ProcessingException("SOURCE_LINK_REJECTED");
        foreach (var part in relative.Split('/')) {
            current = Path.Combine(current, part);
            if (new FileInfo(current).LinkTarget is not null || new DirectoryInfo(current).LinkTarget is not null) throw new ProcessingException("SOURCE_LINK_REJECTED");
        }
        if (!File.Exists(current) || new FileInfo(current).Length > Limit) throw new ProcessingException("SOURCE_LIMIT_OR_UNAVAILABLE");
        return current;
    }
    [System.Runtime.InteropServices.DllImport("libc", SetLastError = true)]
    private static extern int open(string path, int flags);
    public static FileStream Open(string root, string file) {
        if (!OperatingSystem.IsLinux()) throw new ProcessingException("LINUX_PROCESSING_RUNTIME_REQUIRED");
        // O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC; bounded reads also guard growing files.
        var fd = open(file, 0x20000 | 0x800 | 0x80000);
        if (fd < 0) throw new ProcessingException("SOURCE_OPEN_REJECTED");
        var handle = new Microsoft.Win32.SafeHandles.SafeFileHandle(fd, true);
        try {
            var actual = new FileInfo("/proc/self/fd/" + fd).LinkTarget;
            if (actual is null || !actual.StartsWith(Path.GetFullPath(root).TrimEnd('/') + '/', StringComparison.Ordinal)) throw new ProcessingException("SOURCE_LINK_REJECTED");
            var stream = new FileStream(handle, FileAccess.Read);
            if (stream.Length < 1 || stream.Length > Limit) { stream.Dispose(); throw new ProcessingException("SOURCE_LIMIT_OR_UNAVAILABLE"); }
            return stream;
        } catch { handle.Dispose(); throw; }
    }
    public static List<JsonObject> Parse(byte[] bytes, string format) {
        if (bytes.Length > Limit) throw new ProcessingException("SOURCE_LIMIT");
        var result = format switch {
            "csv" => Csv(new UTF8Encoding(false, true).GetString(bytes).TrimStart('\ufeff')),
            "json" => JsonRecords(Data.ParseStrict(bytes)),
            "fhir-json" => FhirRecords(Data.ParseStrict(bytes)),
            "xlsx" => Xlsx(bytes),
            "xml" => XmlRecords(bytes),
            _ => throw new ProcessingException("SOURCE_FORMAT_UNSUPPORTED")
        };
        if (result.Count is < 1 or > 10000) throw new ProcessingException("SOURCE_RECORD_LIMIT");
        var paths = new HashSet<string>(StringComparer.Ordinal); foreach (var record in result) { foreach (var path in Fields(record).Keys) paths.Add(path); if (paths.Count > 256) throw new ProcessingException("SOURCE_FIELD_LIMIT"); }
        return result;
    }
    private static List<JsonObject> JsonRecords(JsonNode? value) {
        if (value is not JsonArray array || array.Any(x => x is not JsonObject)) throw new ProcessingException("SOURCE_RECORD_ARRAY_REQUIRED");
        return array.Select(x => (JsonObject)x!).ToList();
    }
    private static List<JsonObject> FhirRecords(JsonNode? value) {
        // Classification remains unvalidated until the actual release/profile validator passes.
        if (value is JsonObject obj && obj["resourceType"]?.GetValue<string>() == "Bundle") {
            var entries = obj["entry"] as JsonArray ?? throw new ProcessingException("FHIR_ENTRIES_REQUIRED");
            if (obj["type"]?.GetValue<string>() != "collection" || obj.ContainsKey("link") || obj.ContainsKey("total") || entries.Any(e => e is not JsonObject entry || entry.Any(p => p.Key != "resource"))) throw new ProcessingException("FHIR_BUNDLE_CONTEXT_UNSUPPORTED");
            if (entries.Any(e => e?["resource"] is not JsonObject)) throw new ProcessingException("FHIR_ENTRY_RESOURCE_REQUIRED");
            return entries.Select(e => (JsonObject)e!["resource"]!.DeepClone()).ToList();
        }
        if (value is JsonObject resource) return [resource];
        return JsonRecords(value);
    }
    public static SortedDictionary<string, string> Fields(JsonObject record) {
        var fields = new SortedDictionary<string, string>(StringComparer.Ordinal); var visited = 0;
        void Add(string path, string type) {
            fields[path] = fields.TryGetValue(path, out var before) ? string.Join("|", before.Split('|').Append(type).Distinct().Order(StringComparer.Ordinal)) : type;
            if (fields.Count > 256) throw new ProcessingException("SOURCE_FIELD_LIMIT");
        }
        void Visit(JsonNode? node, string path, int depth) {
            if (++visited > 100000 || depth > 32 || path.Length > 512) throw new ProcessingException("SOURCE_DEPTH_LIMIT");
            if (node is JsonObject obj) {
                if (path.Length > 0) Add(path, "object");
                foreach (var item in obj) Visit(item.Value, path + "/" + item.Key.Replace("~", "~0").Replace("/", "~1"), depth + 1);
            } else if (node is JsonArray array) {
                Add(path, "array"); foreach (var item in array) Visit(item, path + "/*", depth + 1);
            } else Add(path, node is null ? "null" : node.GetValueKind() switch { System.Text.Json.JsonValueKind.True or System.Text.Json.JsonValueKind.False => "boolean", System.Text.Json.JsonValueKind.Number => "number", _ => "string" });
        }
        Visit(record, "", 0); return fields;
    }
    public static JsonArray Schema(List<JsonObject> records) => new(records.SelectMany(r => Fields(r)).GroupBy(p => p.Key).OrderBy(g => g.Key, StringComparer.Ordinal)
        .Select(g => (JsonNode)new JsonObject { ["path"] = g.Key, ["types"] = new JsonArray(g.SelectMany(p => p.Value.Split('|')).Distinct().Order(StringComparer.Ordinal).Select(s => (JsonNode)JsonValue.Create(s)!).ToArray()) }).ToArray());
    public static object Describe(List<JsonObject> records) {
        var descriptions = records.Select(Fields).ToArray(); var schema = Schema(records);
        var fields = schema.OfType<JsonObject>().Select(field => new {
            path = field["path"]!.GetValue<string>(), types = field["types"]!.DeepClone(),
            absent = descriptions.Count(d => !d.ContainsKey(field["path"]!.GetValue<string>())),
            nulls = descriptions.Count(d => d.GetValueOrDefault(field["path"]!.GetValue<string>())?.Split('|').Contains("null") == true), meaning = "UNRESOLVED"
        }).ToArray();
        return new { schemaVersion = 2, count = records.Count, schemaSha256 = Data.Hash(Data.Canonical(schema)), sourceSchema = schema, fields, sampleValues = "NOT_INCLUDED", pathConvention = "JSON Pointer with * marking array-item schema paths; executable rules use explicit indices." };
    }
    public static string SchemaHash(List<JsonObject> records) => Data.Hash(Data.Canonical(Schema(records)));
    private static List<JsonObject> Rows(List<List<string>> rows) {
        if (rows.Count < 2 || rows[0].Count is < 1 or > 256 || rows[0].Any(string.IsNullOrEmpty) || rows[0].Distinct().Count() != rows[0].Count) throw new ProcessingException("SOURCE_HEADERS_INVALID");
        var headers = rows[0];
        return rows.Skip(1).Select(row => {
            if (row.Count != headers.Count) throw new ProcessingException("SOURCE_WIDTH_INVALID");
            var record = new JsonObject(); for (var i = 0; i < headers.Count; i++) record[headers[i]] = row[i]; return record;
        }).ToList();
    }
    private static List<JsonObject> Csv(string content) {
        var rows = new List<List<string>>(); var row = new List<string>(); var field = new StringBuilder(); var quoted = false; var closed = false;
        void Emit() { row.Add(field.ToString()); field.Clear(); closed = false; if (row.Count > 256) throw new ProcessingException("SOURCE_FIELD_LIMIT"); }
        for (var i = 0; i < content.Length; i++) {
            var c = content[i];
            if (quoted) { if (c == '"') { if (i + 1 < content.Length && content[i + 1] == '"') { field.Append('"'); i++; } else { quoted = false; closed = true; } } else field.Append(c); }
            else if (c == ',') Emit();
            else if (c is '\n' or '\r') { if (c == '\r' && i + 1 < content.Length && content[i + 1] == '\n') i++; Emit(); rows.Add(row); row = []; }
            else if (c == '"' && field.Length == 0 && !closed) quoted = true;
            else { if (closed || c == '"') throw new ProcessingException("CSV_SYNTAX"); field.Append(c); }
            if (rows.Count > 10001) throw new ProcessingException("SOURCE_RECORD_LIMIT");
        }
        if (quoted) throw new ProcessingException("CSV_SYNTAX");
        if (field.Length > 0 || row.Count > 0 || closed) { Emit(); rows.Add(row); }
        return Rows(rows);
    }
    private static XDocument Xml(Stream stream) {
        using var reader = XmlReader.Create(stream, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = Limit * 2, MaxCharactersFromEntities = 0 });
        return XDocument.Load(reader);
    }
    private static List<JsonObject> XmlRecords(byte[] bytes) {
        using var stream = new MemoryStream(bytes); var document = Xml(stream);
        JsonNode Convert(XElement element, int depth) {
            if (depth > 32) throw new ProcessingException("SOURCE_DEPTH_LIMIT");
            if (!element.HasElements && !element.HasAttributes) return JsonValue.Create(element.Value)!;
            if (element.HasElements && element.Nodes().OfType<XText>().Any(t => !string.IsNullOrWhiteSpace(t.Value))) throw new ProcessingException("XML_MIXED_CONTENT_UNSUPPORTED");
            var obj = new JsonObject();
            foreach (var attr in element.Attributes().Where(a => !a.IsNamespaceDeclaration)) obj["@" + attr.Name] = attr.Value;
            if (!element.HasElements) obj["#text"] = element.Value;
            foreach (var group in element.Elements().GroupBy(e => e.Name.ToString())) obj[group.Key] = group.Count() == 1 ? Convert(group.First(), depth + 1) : new JsonArray(group.Select(e => Convert(e, depth + 1)).ToArray());
            return obj;
        }
        return document.Root?.Elements().Select(e => new JsonObject { [e.Name.ToString()] = Convert(e, 0) }).ToList() ?? throw new ProcessingException("XML_ROOT_REQUIRED");
    }
    private static List<JsonObject> Xlsx(byte[] bytes) {
        using var archive = new ZipArchive(new MemoryStream(bytes), ZipArchiveMode.Read);
        if (archive.Entries.Count > 128 || archive.Entries.Sum(e => e.Length) > Limit * 2) throw new ProcessingException("XLSX_ARCHIVE_LIMIT");
        var ns = XNamespace.Get("http://schemas.openxmlformats.org/spreadsheetml/2006/main");
        XDocument Entry(string path) { using var stream = (archive.GetEntry(path) ?? throw new ProcessingException("XLSX_ENTRY_REQUIRED")).Open(); return Xml(stream); }
        var strings = archive.GetEntry("xl/sharedStrings.xml") is null ? [] : Entry("xl/sharedStrings.xml").Descendants(ns + "si").Select(e => string.Concat(e.Descendants(ns + "t").Select(t => t.Value))).ToArray();
        // Deliberately supports a single data sheet, not spreadsheet formulas or macros.
        if (archive.Entries.Any(e => e.FullName.EndsWith("vbaProject.bin", StringComparison.OrdinalIgnoreCase)) || Entry("xl/workbook.xml").Descendants(ns + "sheet").Count() != 1) throw new ProcessingException("XLSX_SINGLE_DATA_SHEET_REQUIRED");
        var rows = new List<List<string>>();
        foreach (var xmlRow in Entry("xl/worksheets/sheet1.xml").Descendants(ns + "row")) {
            var row = new List<string>();
            foreach (var cell in xmlRow.Elements(ns + "c")) {
                if (cell.Element(ns + "f") is not null) throw new ProcessingException("XLSX_FORMULA_UNSUPPORTED");
                var reference = cell.Attribute("r")?.Value ?? throw new ProcessingException("XLSX_CELL_REFERENCE_REQUIRED");
                var match = Regex.Match(reference, "^([A-Z]{1,3})[1-9][0-9]*$", RegexOptions.CultureInvariant);
                if (!match.Success) throw new ProcessingException("XLSX_CELL_REFERENCE_INVALID");
                var column = match.Groups[1].Value.Aggregate(0, (n, c) => checked(n * 26 + c - 'A' + 1)) - 1;
                if (column > 255 || column < row.Count) throw new ProcessingException("XLSX_COLUMN_LIMIT");
                while (row.Count <= column) row.Add("");
                var text = cell.Element(ns + "v")?.Value ?? "";
                if (cell.Attribute("t")?.Value == "s") { if (!int.TryParse(text, out var index) || index < 0 || index >= strings.Length) throw new ProcessingException("XLSX_STRING_INDEX_INVALID"); text = strings[index]; }
                else if (cell.Attribute("t")?.Value == "inlineStr") text = string.Concat(cell.Descendants(ns + "t").Select(t => t.Value));
                else if (cell.Attribute("t")?.Value == "e") throw new ProcessingException("XLSX_CELL_ERROR");
                row[column] = text;
            }
            if (rows.Count > 0) { if (row.Count > rows[0].Count) throw new ProcessingException("SOURCE_WIDTH_INVALID"); while (row.Count < rows[0].Count) row.Add(""); }
            rows.Add(row); if (rows.Count > 10001) throw new ProcessingException("SOURCE_RECORD_LIMIT");
        }
        return Rows(rows);
    }
}
