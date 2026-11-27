using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Xml;
using System.Xml.Linq;
using System.Xml.Schema;
using System.Xml.XPath;
using Modeller.Core;

namespace Modeller.Operational;

public sealed record XmlAssertion(string Code, string Expression);
public sealed record XmlSourceProfile(string Id, string Version, string RootNamespace, string RootName,
    string EntrySchema, Dictionary<string, string> Files, Dictionary<string, string> Namespaces, XmlAssertion[] Assertions);
public sealed record SourceValidationFinding(string Code, int? Line = null, int? Column = null);
public sealed record SourceValidationReport(bool Valid, string ProfileSha256, string SourceSha256, string[] ExecutedStages,
    SourceValidationFinding[] Findings, bool ClinicalApproval = false);

/// <summary>Compiles pinned, in-memory schema packages. Instance schema locations never enable network access.</summary>
public sealed class XmlSourceValidation
{
    private readonly XmlSourceProfile profile;
    private readonly XmlSchemaSet schemas;
    private readonly (string Code, XPathExpression Expression)[] assertions;
    private readonly string fingerprint;
    private sealed class PackageResolver(Dictionary<string, string> files) : XmlResolver {
        public override ICredentials? Credentials { set { } }
        public override object GetEntity(Uri absoluteUri, string? role, Type? ofObjectToReturn) {
            if (absoluteUri.Scheme != "profile" || absoluteUri.Host != "bundle" || absoluteUri.Query.Length != 0 || absoluteUri.Fragment.Length != 0 || ofObjectToReturn is not null && ofObjectToReturn != typeof(Stream)) throw new ProcessingException("SOURCE_PROFILE_REFERENCE_REJECTED");
            var path = Uri.UnescapeDataString(absoluteUri.AbsolutePath.TrimStart('/'));
            return files.TryGetValue(path, out var content) ? new MemoryStream(Encoding.UTF8.GetBytes(content), false) : throw new ProcessingException("SOURCE_PROFILE_DEPENDENCY_MISSING");
        }
    }
    public XmlSourceValidation(XmlSourceProfile input) {
        // Take an immutable snapshot; later mutations by an adapter cannot change an already compiled profile.
        profile = JsonSerializer.Deserialize<XmlSourceProfile>(JsonSerializer.Serialize(input, Data.Json), Data.Json) ?? throw new ProcessingException("SOURCE_PROFILE_REQUIRED");
        if (string.IsNullOrWhiteSpace(profile.Id) || profile.Id.Length > 128 || string.IsNullOrWhiteSpace(profile.Version) || profile.Version.Length > 100 || profile.Files.Count is < 1 or > 128 || profile.Assertions.Length > 100 || profile.Namespaces.Count > 32) throw new ProcessingException("SOURCE_PROFILE_LIMIT_OR_INVALID");
        foreach (var file in profile.Files) {
            if (file.Key.Length > 256 || !System.Text.RegularExpressions.Regex.IsMatch(file.Key, "^[A-Za-z0-9_./-]+$") || file.Key.Split('/').Any(part => part is "" or "." or "..") || Encoding.UTF8.GetByteCount(file.Value) > 4194304) throw new ProcessingException("SOURCE_PROFILE_FILE_INVALID");
        }
        if (profile.Files.Sum(pair => (long)Encoding.UTF8.GetByteCount(pair.Value)) > 16777216 || !profile.Files.ContainsKey(profile.EntrySchema)) throw new ProcessingException("SOURCE_PROFILE_PACKAGE_LIMIT_OR_INVALID");
        _ = XmlConvert.VerifyNCName(profile.RootName);
        if (!Uri.TryCreate(profile.RootNamespace, UriKind.Absolute, out _)) throw new ProcessingException("SOURCE_PROFILE_NAMESPACE_REQUIRED");
        var resolver = new PackageResolver(profile.Files);
        schemas = new XmlSchemaSet { XmlResolver = resolver };
        var schemaFailed = false;
        schemas.ValidationEventHandler += (_, _) => schemaFailed = true;
        try {
            foreach (var schema in profile.Files.Values) _ = ClinicalMessages.Xml(Encoding.UTF8.GetBytes(schema));
            using var reader = XmlReader.Create(new StringReader(profile.Files[profile.EntrySchema]), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 8388608 }, "profile://bundle/" + profile.EntrySchema);
            schemas.Add(null, reader); schemas.Compile();
            if (schemaFailed || schemas.Count == 0) throw new ProcessingException("SOURCE_PROFILE_SCHEMA_INCOMPLETE");
        } catch (XmlSchemaException) { throw new ProcessingException("SOURCE_PROFILE_SCHEMA_INVALID"); }
        var namespaces = new XmlNamespaceManager(new NameTable());
        foreach (var entry in profile.Namespaces) {
            if (entry.Key is "xml" or "xmlns" || string.IsNullOrEmpty(entry.Key) || !Uri.TryCreate(entry.Value, UriKind.Absolute, out _)) throw new ProcessingException("SOURCE_PROFILE_NAMESPACE_REQUIRED");
            namespaces.AddNamespace(XmlConvert.VerifyNCName(entry.Key), entry.Value);
        }
        assertions = profile.Assertions.Select(assertion => {
            if (!System.Text.RegularExpressions.Regex.IsMatch(assertion.Code, "^[A-Za-z0-9_.-]{1,100}$") || assertion.Expression.Length is < 1 or > 2048) throw new ProcessingException("SOURCE_PROFILE_ASSERTION_INVALID");
            try { var expression = XPathExpression.Compile(assertion.Expression); expression.SetContext(namespaces); return (assertion.Code, expression); }
            catch (XPathException) { throw new ProcessingException("SOURCE_PROFILE_ASSERTION_INVALID"); }
        }).ToArray();
        fingerprint = Data.Hash(Data.Canonical(JsonSerializer.SerializeToNode(profile, Data.Json)));
    }
    public SourceValidationReport Validate(byte[] original) {
        if (original.Length is < 1 or > Sources.Limit) throw new ProcessingException("MESSAGE_SIZE_LIMIT");
        var findings = new List<SourceValidationFinding>();
        void Add(string code, int? line = null, int? column = null) { if (findings.Count < 100) findings.Add(new(code, line, column)); }
        var document = ClinicalMessages.Xml(original);
        if (document.Root?.Name != XName.Get(profile.RootName, profile.RootNamespace)) Add("SOURCE_PROFILE_ROOT_MISMATCH");
        var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, ValidationType = ValidationType.Schema, MaxCharactersInDocument = Sources.Limit * 2L };
        settings.Schemas.Add(schemas);
        settings.ValidationFlags = XmlSchemaValidationFlags.ProcessIdentityConstraints | XmlSchemaValidationFlags.ReportValidationWarnings | XmlSchemaValidationFlags.AllowXmlAttributes;
        settings.ValidationEventHandler += (_, error) => Add(error.Severity == XmlSeverityType.Warning ? "SOURCE_SCHEMA_WARNING" : "SOURCE_SCHEMA_VALIDATION", error.Exception?.LineNumber, error.Exception?.LinePosition);
        try {
            using var input = new MemoryStream(original); using var reader = XmlReader.Create(input, settings); while (reader.Read()) { }
        } catch (XmlException) { Add("SOURCE_XML_INVALID"); }
        if (findings.Count == 0) {
            var navigator = document.CreateNavigator();
            foreach (var assertion in assertions) {
                try {
                    var result = navigator.Evaluate(assertion.Expression);
                    if (result is not bool valid) throw new ProcessingException("SOURCE_PROFILE_ASSERTION_BOOLEAN_REQUIRED");
                    if (!valid) Add(assertion.Code);
                } catch (XPathException) { throw new ProcessingException("SOURCE_PROFILE_ASSERTION_INVALID"); }
            }
        }
        return new(findings.Count == 0, fingerprint, Convert.ToHexStringLower(SHA256.HashData(original)), assertions.Length == 0 ? ["XML", "XSD"] : ["XML", "XSD", "PROFILE_XPATH"], findings.ToArray());
    }
}
