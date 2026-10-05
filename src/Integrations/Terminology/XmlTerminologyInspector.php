<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Terminology;

use DOMElement;
use OpenEHR\Assistant\Domain\Terminology\Catalogue\Resource;
use OpenEHR\Assistant\Domain\Terminology\ModelTerminologyInspector;
use OpenEHR\Assistant\Validation\ModelValidator;
use OpenEHR\Assistant\Validation\XmlLocations;

/** Explicit OET/OPT XML inspection; inherited ADL semantics belong to the qualified engine. */
final class XmlTerminologyInspector implements ModelTerminologyInspector
{
    private const string OET = 'openEHR/v1/Template';
    private const array OPT = ['http://schemas.openehr.org/v1', 'http://schemas.openehr.org/v2'];

    public function inspect(string $content, string $format): array
    {
        $hash = hash('sha256', $content);
        if (!in_array($format, ['oet', 'opt', 'xml'], true)) {
            return ['status' => 'NOT_EXECUTED', 'scope' => 'explicit_xml_terminology', 'slots' => [], 'existing_bindings' => [],
                'content_sha256' => $hash, 'findings' => [$this->finding('TERMINOLOGY_INSPECTOR_UNAVAILABLE', '',
                    'A qualified terminology inspector for this source format is not configured.', 'Inspect this source with the openEHR engine.')]];
        }
        $document = ModelValidator::xml($content); $root = $document->documentElement;
        $namespace = $root?->namespaceURI;
        if ($root?->localName !== 'template' || ($namespace !== self::OET && !in_array($namespace, self::OPT, true))
            || ($format === 'oet' && $namespace !== self::OET) || ($format === 'opt' && !in_array($namespace, self::OPT, true))) {
            throw new \InvalidArgumentException('UNSUPPORTED_TERMINOLOGY_XML_PROFILE');
        }
        $slots = []; $bindings = []; $findings = []; $codingCount = 0;
        foreach (XmlLocations::index($document) as $location => $element) {
            if ($element->namespaceURI !== $namespace) { continue; }
            $type = $this->type($element); $slot = null;
            if ($namespace === self::OET && ($type === 'textConstraint'
                || in_array($element->localName, ['nameConstraint', 'nullFlavourConstraint', 'nullFlavorConstraint', 'SubjectOfCare'], true))) {
                $slot = $this->oet($element);
            } elseif (in_array($namespace, self::OPT, true) && in_array($type, ['C_CODE_PHRASE', 'C_CODE_REFERENCE'], true)) {
                $slot = $this->opt($element);
            } elseif (in_array($namespace, self::OPT, true) && $type === 'C_TERMINOLOGY_CODE') {
                $findings[] = $this->finding('TERMINOLOGY_EXPRESSION_NOT_RESOLVED', $location,
                    'This AOM 2 terminology expression requires the qualified engine.', 'Resolve the expression and archetype terminology through the engine.');
            }
            if ($slot !== null) {
                $codingCount += count($slot['codings']) + count($slot['unresolved_literals']);
                if (count($slot['codings']) > 100 || count($slot['included_values']) + count($slot['excluded_values']) > 200 || $codingCount > 2000) { throw new \InvalidArgumentException('TERMINOLOGY_INSPECTION_LIMIT_EXCEEDED'); }
                $context = $this->context($element);
                $slots[] = $slot + ['location' => $location, 'element' => $element->localName,
                    'declared_path' => $context['path'], 'archetype' => $context['archetype'], 'context' => $context['placements'],
                    'source_format' => $namespace === self::OET ? 'oet' : 'opt', 'native_semantics_verified' => false];
            }
            if (in_array($namespace, self::OPT, true) && in_array($element->localName, ['term_bindings', 'constraint_bindings'], true)) {
                $bindings[] = ['location' => $location, 'kind' => $element->localName, 'terminology' => $element->getAttribute('terminology'),
                    'xml_sha256' => hash('sha256', $document->saveXML($element) ?: ''), 'context' => $this->context($element)];
            }
            if (count($slots) + count($bindings) + count($findings) > 100) { throw new \InvalidArgumentException('TERMINOLOGY_INSPECTION_LIMIT_EXCEEDED'); }
        }
        return ['status' => 'PARTIAL', 'scope' => 'explicit_xml_terminology', 'content_sha256' => $hash,
            'slots' => $slots, 'existing_bindings' => $bindings, 'findings' => $findings,
            'limitations' => ['Inherited archetype constraints, ADL/AOM expressions and full model conformance require the qualified engine.',
                'Element-position locators are tied to this exact source hash; they are not openEHR semantic paths.'], 'model_changed' => false];
    }

    /** @return array<string, mixed>|null */
    private function oet(DOMElement $element): ?array
    {
        $codes = []; $unresolved = []; $references = []; $included = []; $excluded = [];
        foreach ($this->children($element) as $child) {
            if ($child->localName === 'termQueryId') {
                // OET declares a named query, not a FHIR ValueSet URL. Preserve its exact identity.
                $references[] = ['kind' => 'oet_named_query', 'terminology_id' => $child->getAttribute('terminologyID'),
                    'language' => $child->getAttribute('terminologyLang'), 'query_name' => $child->getAttribute('queryName'),
                    'canonical' => null, 'version' => null];
            }
            if (in_array($child->localName, ['includedValues', 'excludedValues'], true)) {
                $raw = $child->textContent;
                if ($child->localName === 'excludedValues') { $excluded[] = $raw; continue; }
                $included[] = $raw;
                if (substr_count($raw, '::') === 1 && preg_match('/^([^\s]+)::([^\s]+)$/Du', $raw, $match)) {
                    $codes[] = ['terminology_id' => $match[1], 'code' => $match[2], 'version' => null];
                } else { $unresolved[] = $raw; }
            }
        }
        if ($codes === [] && $references === [] && $included === [] && $excluded === []) { return null; }
        return ['codings' => $codes, 'unresolved_literals' => $unresolved, 'existing_references' => $references,
            'included_values' => $included, 'excluded_values' => $excluded, 'limit_to_list' => $element->getAttribute('limitToList') ?: null];
    }

    /** @return array<string, mixed> */
    private function opt(DOMElement $element): array
    {
        $system = null; $codes = []; $references = [];
        foreach ($this->children($element) as $child) {
            if ($child->localName === 'terminology_id') {
                foreach ($this->children($child) as $value) { if ($value->localName === 'value') { $system = $value->textContent; } }
            }
        }
        foreach ($this->children($element) as $child) {
            if ($child->localName === 'code_list') { $codes[] = ['terminology_id' => $system, 'code' => $child->textContent, 'version' => null]; }
            if ($child->localName === 'referenceSetUri') {
                $canonical = $child->textContent;
                try { Resource::canonical($canonical); } catch (\InvalidArgumentException) { $canonical = null; }
                $references[] = ['kind' => 'value_set_reference', 'raw' => $child->textContent, 'canonical' => $canonical, 'version' => null];
            }
        }
        return ['codings' => $codes, 'unresolved_literals' => [], 'existing_references' => $references,
            'included_values' => [], 'excluded_values' => [], 'limit_to_list' => null];
    }

    /** @return list<DOMElement> */
    private function children(DOMElement $element): array
    {
        $children = [];
        foreach ($element->childNodes as $child) {
            if ($child instanceof DOMElement && $child->namespaceURI === $element->namespaceURI) { $children[] = $child; }
        }
        return $children;
    }

    private function type(DOMElement $element): ?string
    {
        $value = $element->getAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'type');
        if ($value === '') { return null; }
        $parts = explode(':', $value);
        if (count($parts) > 2) { return null; }
        $namespace = $element->lookupNamespaceURI(count($parts) === 2 ? $parts[0] : null);
        return $namespace === $element->namespaceURI ? $parts[count($parts) - 1] : null;
    }

    /** @return array<string, mixed> */
    private function context(DOMElement $element): array
    {
        $path = null; $archetype = null; $placements = [];
        for ($node = $element; $node instanceof DOMElement; $node = $node->parentNode) {
            if ($node->namespaceURI !== $element->namespaceURI) { continue; }
            if ($path === null && $node->hasAttribute('path')) { $path = $node->getAttribute('path'); }
            $id = $node->getAttribute('archetype_id');
            if ($id === '') {
                foreach ($this->children($node) as $child) {
                    if ($child->localName === 'archetype_id') {
                        foreach ($this->children($child) as $value) { if ($value->localName === 'value') { $id = $value->textContent; } }
                    }
                }
            }
            if ($id !== '') { $archetype ??= $id; $placements[] = ['archetype' => $id, 'path' => $node->getAttribute('path') ?: null]; }
        }
        return ['path' => $path, 'archetype' => $archetype, 'placements' => array_reverse($placements)];
    }

    /** @return array<string, mixed> */
    private function finding(string $code, string $location, string $message, string $remediation): array
    {
        return ['severity' => 'warning', 'code' => $code, 'location' => $location, 'message' => $message,
            'evidence' => ['scope' => 'explicit_xml_terminology'], 'remediation' => $remediation];
    }
}
