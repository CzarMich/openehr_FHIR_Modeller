<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tools;

use Mcp\Capability\Attribute\McpTool;
use Mcp\Capability\Attribute\Schema;
use Mcp\Schema\ToolAnnotations;
use OpenEHR\Assistant\Application\FhirModelling;
use OpenEHR\Assistant\Helpers\ToolResult;

/** Authoring/validation tools. The existing IG server remains the distribution authority. */
final readonly class FhirTools
{
    public function __construct(private FhirModelling $fhir) {}

    /** List, inspect or configure isolated FHIR projects. document is JSON project configuration; exact dependencies and a release are required. Never include credentials.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'fhir_project', annotations: new ToolAnnotations(readOnlyHint: false, destructiveHint: false, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function project(#[Schema(enum: ['list', 'get', 'create', 'update'])] string $action,
        #[Schema(minLength: 1, maxLength: 80)] ?string $projectId = null,
        #[Schema(maxLength: 65536)] ?string $document = null,
        #[Schema(maxLength: 128)] ?string $expectedRevision = null): array
    { return ToolResult::run(fn (): array => $this->fhir->project($action, $projectId, $document, $expectedRevision)); }

    /** Discover and resolve exact-version packages for the project release. arguments is JSON with id, version, source, query or canonical; install stores immutable package originals.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'fhir_package', annotations: new ToolAnnotations(readOnlyHint: false, destructiveHint: false, openWorldHint: true), outputSchema: ToolResult::SCHEMA)]
    public function package(#[Schema(enum: ['search', 'get', 'install', 'dependencies', 'artifacts', 'resolve'])] string $action,
        #[Schema(minLength: 1, maxLength: 80)] string $projectId,
        #[Schema(maxLength: 8388608)] string $arguments = '{}'): array
    { return ToolResult::run(fn (): array => $this->fhir->operation('package', $action, $projectId, $arguments)); }

    /** Inspect, save and compare authored or imported artefacts. arguments is JSON: save needs path/content/format/representation/expectedRevision; validate content or path; diff before/after. Preserve imported originals.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'fhir_artifact', annotations: new ToolAnnotations(readOnlyHint: false, destructiveHint: false, openWorldHint: true), outputSchema: ToolResult::SCHEMA)]
    public function artifact(#[Schema(enum: ['inspect', 'get', 'search', 'save', 'validate', 'diff', 'history'])] string $action,
        #[Schema(minLength: 1, maxLength: 80)] string $projectId,
        #[Schema(maxLength: 8388608)] string $arguments = '{}'): array
    { return ToolResult::run(fn (): array => $this->fhir->operation('artifact', $action, $projectId, $arguments)); }

    /** Perform reuse analysis before drafting profiles. JSON arguments include requirement, baseResource, typed constraints and parentCanonical. Generated drafts need actual compilation and validation; no clinical approval.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'fhir_profile', annotations: new ToolAnnotations(readOnlyHint: true, destructiveHint: false, openWorldHint: true), outputSchema: ToolResult::SCHEMA)]
    public function profile(#[Schema(enum: ['discover', 'generate', 'validate'])] string $action,
        #[Schema(minLength: 1, maxLength: 80)] string $projectId,
        #[Schema(maxLength: 8388608)] string $arguments = '{}'): array
    { return ToolResult::run(fn (): array => $this->fhir->operation('profile', $action, $projectId, $arguments)); }

    /** Validate or evaluate a FHIRPath expression against synthetic resources with the explicit project release. JSON arguments contain expression and resource.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'fhir_fhirpath', annotations: new ToolAnnotations(readOnlyHint: true, destructiveHint: false, openWorldHint: true), outputSchema: ToolResult::SCHEMA)]
    public function fhirpath(#[Schema(enum: ['validate', 'evaluate'])] string $action,
        #[Schema(minLength: 1, maxLength: 80)] string $projectId,
        #[Schema(maxLength: 8388608)] string $arguments = '{}'): array
    { return ToolResult::run(fn (): array => $this->fhir->operation('fhirpath', $action, $projectId, $arguments)); }

    /** Create versioned cross-standard mapping proposals independently of source models. JSON arguments preserve source and target versions and paths; equivalence is never automatic.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'fhir_mapping', annotations: new ToolAnnotations(readOnlyHint: false, destructiveHint: false, openWorldHint: true), outputSchema: ToolResult::SCHEMA)]
    public function mapping(#[Schema(enum: ['list', 'get', 'save', 'analyse'])] string $action,
        #[Schema(minLength: 1, maxLength: 80)] string $projectId,
        #[Schema(maxLength: 8388608)] string $arguments = '{}'): array
    { return ToolResult::run(fn (): array => $this->fhir->operation('mapping', $action, $projectId, $arguments)); }

    /** Inspect named deployment-managed connections. JSON arguments contain id; validate sends a synthetic resource only. Credentials are never tool arguments. Runtime patient-data search is browser-only.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'fhir_connection', annotations: new ToolAnnotations(readOnlyHint: true, destructiveHint: false, openWorldHint: true), outputSchema: ToolResult::SCHEMA)]
    public function connection(#[Schema(enum: ['list', 'get', 'test', 'metadata', 'validate'])] string $action,
        #[Schema(minLength: 1, maxLength: 80)] string $projectId,
        #[Schema(maxLength: 8388608)] string $arguments = '{}'): array
    { return ToolResult::run(fn (): array => $this->fhir->operation('connection', $action, $projectId, $arguments)); }

    /** Connect to the existing IG server. JSON arguments: submit paths of locally validated resources; sync an exact commitSha through configured Git link. Imports remain drafts; review and publication belong to the IG platform.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'fhir_ig', annotations: new ToolAnnotations(readOnlyHint: false, destructiveHint: false, openWorldHint: true), outputSchema: ToolResult::SCHEMA)]
    public function ig(#[Schema(enum: ['test', 'projects', 'status', 'submit', 'sync'])] string $action,
        #[Schema(minLength: 1, maxLength: 80)] string $projectId,
        #[Schema(maxLength: 8388608)] string $arguments = '{}'): array
    { return ToolResult::run(fn (): array => $this->fhir->operation('ig', $action, $projectId, $arguments)); }

    /** Compile FSH with pinned SUSHI for the project release. JSON arguments contain files:[{path,content}]. Generated output remains a draft and requires validator evidence.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'fhir_fsh_compile', annotations: new ToolAnnotations(readOnlyHint: true, destructiveHint: false, openWorldHint: true), outputSchema: ToolResult::SCHEMA)]
    public function compile(#[Schema(minLength: 1, maxLength: 80)] string $projectId,
        #[Schema(maxLength: 8388608)] string $arguments = '{}'): array
    { return ToolResult::run(fn (): array => $this->fhir->operation('fsh', 'compile', $projectId, $arguments)); }
    /** Draft synthetic examples from actual StructureDefinition constraints. JSON arguments contain content (the profile), id and explicit path values. Missing clinical choices remain gaps; run profile validation separately.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'fhir_example_generate', annotations: new ToolAnnotations(readOnlyHint: true, destructiveHint: false, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function example(#[Schema(minLength: 1, maxLength: 80)] string $projectId,
        #[Schema(maxLength: 8388608)] string $arguments = '{}'): array
    { return ToolResult::run(fn (): array => $this->fhir->operation('examples', 'generate', $projectId, $arguments)); }

}
