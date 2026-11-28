# Third-party notices

These notices apply **only to the identified third-party portions**, not to ownership or maintenance of openEHR Modeller as a whole. The current product is independently maintained and developed by Michael Anywar and is licensed under the [MIT License](LICENSE). Separately licensed material retains the terms below.

## Incorporated upstream application portions — MIT

Source: [openEHR Assistant MCP](https://github.com/cadasto/openehr-assistant-mcp), inherited through [the earlier fork](https://github.com/CzarMich/openehr-assistant-mcp), baseline commit `600db3ecb4d5fe3e865393dc4fb976715e475fbe`.

Substantial portions remain in the CKM client, MCP tools/prompts/resources/completion providers, helpers, tests, guides, prompt bodies and project infrastructure. Some files have been modified, including namespace and security changes; those changes do not erase upstream rights. The [provenance inventory](docs/licensing/upstream-inventory.tsv) identifies inherited files at the recorded revision. Separately sourced openEHR data and models have their own terms below. The upstream company and contributors are not owners, maintainers or vendors of the current product.

The following upstream notice is preserved verbatim from that baseline:

```text
MIT License

Copyright (c) 2025 Cadasto B.V.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Bundled openEHR material

These resources are third-party material, not Michael Anywar's original product code. Embedded authorship, translation credits, copyright, IP acknowledgements and license fields are retained unchanged.

| Material actually present | Attribution and applicable terms |
|---|---|
| Seven ADL files in `resources/examples/archetypes/` | openEHR Foundation and the authors/contributors recorded in each file. Each file explicitly carries [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Files are unchanged from the inherited baseline; preserve their internal notices when extracting or redistributing them. |
| `resources/terminology/openehr_terminology.xml` | openEHR Foundation; inherited support terminology (version 3.1.0, 2024-04-11). Source: [openEHR specifications-TERM](https://github.com/openEHR/specifications-TERM/tree/master/computable/XML/en), whose [repository license](https://github.com/openEHR/specifications-TERM/blob/master/LICENSE) is [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). The bundled file is unchanged from the baseline. |
| 424 JSON definitions in `resources/bmm/` and specification-derived text in `resources/guides/specs/` | openEHR Foundation and source contributors. Source components and development specification links are recorded in the guides. These inherited resources retain their source terms. Source repositories and published specification documents carry different Creative Commons notices; the exact license/provenance of each extracted JSON snapshot is not established by this checkout. Preserve all existing source attribution. |
| CGEM material in `resources/guides/templates/cgem-framework.md` and its linked template guidance | Framework by **freshEHR Clinical Informatics**, [Introduction to the CGEM Framework](https://freshehr.notion.site/Introduction-to-the-CGEM-Framework-115ed58514b344da825c3b42c372aff2). The inherited attribution describes the framework as CC-BY; its exact license version was not supplied. This repository's guide is an adaptation/explanation, not an official specification. Source credit and the framework's own terms remain in the guide. |

No SNOMED CT, LOINC or other restricted external terminology database is bundled. Names and example IP-acknowledgement fields are not licenses to those databases. Retrieved clinical models and terminology responses retain their source's terms; the product's terms do not override them.

## Installed software dependencies

The inventory is recorded in the `dotnet/*/packages.lock.json` files, `chat/package-lock.json`, `engine/pom.xml` and the engine's generated `sbom.json`. These are independent packages, not product owners. Keep their complete license and NOTICE files with any distributed copy; the descriptions here do not replace those files.

- **Browser:** the Anthropic SDK, Microsoft Agents Copilot Studio client, MSAL, openid-client/oauth4webapi, ipaddr.js and node-qrcode are MIT; PDF.js, SheetJS Community Edition and sharp are Apache-2.0; Mammoth is BSD-2-Clause. Their transitive packages and native image-processing libraries retain their own terms in `node_modules` (including libvips and its LGPL-2.1-or-later notice). Provider names identify supported integrations only.
- **Browser tooling/runtime:** Node.js includes its own MIT and bundled notices. The pinned OpenAI Codex distribution is Apache-2.0 with bundled notices. Playwright and the development-only jsQR scanner are Apache-2.0; Prettier is MIT; axe-core is MPL-2.0. These notices remain in the installed distributions. The browser images copy this file and the product LICENSE to `/app/`.
- **Native engine:** Archie and the openEHR SDK are Apache-2.0; their transitive dependencies carry their own licenses. The engine distributes separate dependency JARs, preserving embedded `META-INF` license/NOTICE files, and a generated SBOM. Product notices are included in the engine JAR and image; they do not replace dependency notices. Dependencies with reciprocal licenses, such as the Jakarta JSON implementations, remain under their own terms.
- **Container services:** .NET, Caddy, PostgreSQL, Java, operating-system packages and development tools retain the licenses and notices of their pinned distributions. Nothing here relicenses these runtimes or services.

Historical inspiration and general acknowledgements have not been promoted to ownership claims or treated as evidence of incorporated code. Git history preserves the actual contributors and commit metadata. Product compatibility and trademarks do not imply endorsement.

## C# MCP runtime

The .NET application uses the official [C# MCP SDK](https://github.com/modelcontextprotocol/csharp-sdk) with its exact upstream license/transition notice and third-party notices retained in `dotnet/notices/`. Microsoft .NET and its runtime image retain their own license and third-party notices. Exact NuGet dependencies/checksums are recorded in `dotnet/Modeller.Mcp/packages.lock.json`; no SDK source is vendored. Published application images also retain installed NuGet licence/NOTICE files and package metadata under `notices/nuget/`; these do not replace upstream rights. Existing guide content and upstream credits are preserved unchanged.

## Vendor source drivers

Source adapters use the locked Microsoft.Data.SqlClient, Npgsql, MySqlConnector, Oracle.ManagedDataAccess.Core and System.Data.Odbc packages. Their package licenses and notices are retained by the NuGet notice collector; the application license does not replace them. MySqlConnector and System.Data.Odbc retain their MIT terms; Npgsql retains its PostgreSQL license. Oracle.ManagedDataAccess.Core is distributed unmodified with the [Oracle Free Distribution, Hosting, and Use Terms and Conditions](dotnet/notices/licenses/Oracle.ManagedDataAccess.Core.LICENSE.txt). That complete license is included in the distributed notices.

The proprietary SAP HANA ODBC client is not included in this repository or its default images. Operators must install an appropriately licensed client and pin its checksum. The adapter never downloads or loads an agent-supplied driver. Oracle and SAP product names identify compatibility, not ownership or endorsement.

## Kafka client

The private Kafka intake uses Confluent.Kafka and librdkafka.redist (locked NuGet packages). Preserve their Apache-2.0/BSD notices and transitive license material collected in the runtime notice directory. The disposable acceptance fixture uses the prebuilt Apache Kafka image under Apache-2.0; it is not bundled as a broker in the application. See the pinned lockfiles and upstream package notices for complete terms.

## Inter UI font

Both workspaces serve the unmodified Inter Variable 4.1 font locally, under the SIL Open Font License 1.1. Copyright and full terms are included in [Inter-OFL.txt](public/chat/Inter-OFL.txt). Upstream: [rsms/inter v4.1](https://github.com/rsms/inter/tree/v4.1); font SHA-256 `693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3`. Runtime font requests use the application origin and immutable content-versioned caching.
