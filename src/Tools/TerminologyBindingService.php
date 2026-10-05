<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tools;

use Mcp\Capability\Attribute\McpTool;
use Mcp\Capability\Attribute\Schema;
use Mcp\Schema\ToolAnnotations;
use OpenEHR\Assistant\Domain\Terminology\BindingService;
use OpenEHR\Assistant\Domain\Terminology\ValueSet;
use OpenEHR\Assistant\Helpers\ToolResult;
use OpenEHR\Assistant\Integrations\Terminology\FhirTerminologyProvider;

final readonly class TerminologyBindingService
{
    public function __construct(private FhirTerminologyProvider $provider, private BindingService $bindings)
    {
    }

    /** Read the configured FHIR provider's capability statement. Never assumes every operation exists.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'terminology_capabilities', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: true), outputSchema: ToolResult::SCHEMA)]
    public function capabilities(): array
    {
        return ToolResult::run(fn (): array => $this->provider->capabilities());
    }

    /** Look up a code and display in the configured external terminology server.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'terminology_lookup', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: true), outputSchema: ToolResult::SCHEMA)]
    public function lookup(string $system, string $code, ?string $version = null, ?string $language = null): array
    {
        return ToolResult::run(fn (): array => $this->provider->lookup($system, $code, $version, $language));
    }

    /** Verify a code against a code system or value set; unavailable validation returns NOT_EXECUTED.
     * version identifies the ValueSet when valueSet is set, otherwise the CodeSystem.
     * @return array<string, mixed>
     */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'terminology_validate_code', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: true), outputSchema: ToolResult::SCHEMA)]
    public function validateCode(string $system, string $code, ?string $valueSet = null, ?string $version = null,
        ?string $codeSystemVersion = null, ?string $display = null, ?string $language = null): array
    {
        return ToolResult::run(fn (): array => $this->provider->validateCode($system, $code, $valueSet, $version, $codeSystemVersion, $display, $language));
    }

    /** Request a bounded value-set expansion. The server may return a partial page; never treat it as the whole value set.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'terminology_expand', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: true), outputSchema: ToolResult::SCHEMA)]
    public function expand(string $valueSet, ?string $version = null, #[Schema(minimum: 0, maximum: 500)] int $count = 50,
        #[Schema(minimum: 0, maximum: 1000000)] int $offset = 0, ?string $language = null, ?string $filter = null): array
    {
        return ToolResult::run(fn (): array => $this->provider->expand($valueSet, $version, $count, $offset, $language, $filter));
    }

    /** Translate using an explicit ConceptMap. All candidate mappings require human review; no binding is changed.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'terminology_translate', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: true), outputSchema: ToolResult::SCHEMA)]
    public function translate(string $conceptMap, string $system, string $code, ?string $version = null,
        ?string $codeSystemVersion = null, ?string $sourceValueSet = null, ?string $targetValueSet = null,
        ?string $targetSystem = null): array
    {
        return ToolResult::run(fn (): array => $this->provider->translate($conceptMap, $system, $code, $version,
            $codeSystemVersion, $sourceValueSet, $targetValueSet, $targetSystem));
    }

    /** Discover CodeSystem, ValueSet or ConceptMap resources on the configured server. A bounded page may be incomplete.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'terminology_resource_search', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: true), outputSchema: ToolResult::SCHEMA)]
    public function search(#[Schema(enum: ['CodeSystem', 'ValueSet', 'ConceptMap'])] string $resourceType,
        ?string $canonical = null, ?string $version = null, ?string $name = null,
        #[Schema(minimum: 1, maximum: 100)] int $count = 50): array
    {
        return ToolResult::run(fn (): array => $this->provider->search($resourceType, $canonical, $version, $name, $count));
    }

    /** Retrieve a uniquely resolved canonical and optional version. Never silently choose between multiple editions.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'terminology_resource_get', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: true), outputSchema: ToolResult::SCHEMA)]
    public function resource(#[Schema(enum: ['CodeSystem', 'ValueSet', 'ConceptMap'])] string $resourceType,
        string $canonical, ?string $version = null): array
    {
        return ToolResult::run(fn (): array => $this->provider->resource($resourceType, $canonical, $version));
    }

    /** Validate an explicit platform terminology binding against a versioned value set and supplied OET/XML. Native binding application is not performed.
     *
     * @param array<string, mixed> $binding
     * @param array<string, mixed> $valueSet
     * @return array<string, mixed>
     */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'terminology_binding_validate', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: true), outputSchema: ToolResult::SCHEMA)]
    public function validateBinding(#[Schema(type: 'object')] array $binding, #[Schema(type: 'object')] array $valueSet,
        #[Schema(maxLength: 2097152)] string $model): array
    {
        return ToolResult::run(fn (): array => $this->bindings->validate($binding, ValueSet::fromArray($valueSet), $model));
    }

    /** Compare value-set concepts semantically; report changes without automatically replacing codes.
     *
     * @param array<string, mixed> $before
     * @param array<string, mixed> $after
     * @return array<string, mixed>
     */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'terminology_diff', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function diff(#[Schema(type: 'object')] array $before, #[Schema(type: 'object')] array $after): array
    {
        return ToolResult::run(fn (): array => $this->bindings->diff(ValueSet::fromArray($before), ValueSet::fromArray($after)));
    }

    /** Produce declared terminology dependencies for a template from explicit binding records.
     *
     * @param list<array<string, mixed>> $bindings
     * @return array<string, mixed>
     */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'terminology_manifest', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function manifest(string $artifact, #[Schema(items: ['type' => 'object'], maxItems: 1000)] array $bindings): array
    {
        return ToolResult::run(fn (): array => $this->bindings->manifest($artifact, $bindings));
    }
}
