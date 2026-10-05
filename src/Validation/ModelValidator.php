<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Validation;

use DOMDocument;
use DOMElement;
use InvalidArgumentException;

/** Bounded structural validation. This is not an ADL parser or an OPT compiler. */
final class ModelValidator
{
    public const string ARCHETYPE_ID = '/^openEHR-[A-Z_]+-[A-Z_]+\.[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\.v[0-9]+(?:\.[0-9]+)*$/D';

    public static function xml(string $content): DOMDocument
    {
        if ($content === '' || strlen($content) > 2097152 || str_contains($content, "\0")
            || preg_match('/<!\s*(DOCTYPE|ENTITY)/i', $content)) {
            throw new InvalidArgumentException('XML_EMPTY_OVERSIZED_OR_UNSAFE: DTDs and entities are prohibited.');
        }
        $previous = libxml_use_internal_errors(true);
        try {
            $document = new DOMDocument();
            $document->resolveExternals = false;
            $document->substituteEntities = false;
            if (!$document->loadXML($content, LIBXML_NONET | LIBXML_NOBLANKS) || $document->doctype !== null) {
                throw new InvalidArgumentException('XML_MALFORMED: unable to parse XML.');
            }
            if ($document->getElementsByTagName('*')->length > 20000) {
                throw new InvalidArgumentException('XML_TOO_COMPLEX: element limit exceeded.');
            }
            return $document;
        } finally {
            libxml_clear_errors();
            libxml_use_internal_errors($previous);
        }
    }

    /**
     * @return array<string, mixed>
     */
    public function validate(string $content, string $format): array
    {
        if (!in_array($format, ['xml', 'oet', 'opt', 'adl', 'aql', 'flat', 'structured'], true)) {
            throw new InvalidArgumentException('Unsupported validation format.');
        }
        $findings = new Findings();
        $executed = [];
        $parse = null;
        $structure = null;
        $stages = [];
        $reasons = [
            'parse' => 'A qualified language parser is not configured.',
            'structure' => 'No structural profile was executed.',
            'semantics' => 'Semantic compatibility requires model-aware engine validation.',
            'terminology' => 'No pinned terminology context was supplied to this document check.',
            'openehr_conformance' => 'Complete openEHR conformance requires the qualified engine and resolved dependencies.',
            'repository_policy' => 'No repository revision or policy context was supplied.',
        ];
        foreach ($reasons as $name => $reason) {
            $stages[$name] = ['name' => $name, 'status' => 'NOT_EXECUTED', 'reason' => $reason, 'qualified' => false];
        }
        try {
            if ($content === '' || strlen($content) > 2097152 || str_contains($content, "\0") || !mb_check_encoding($content, 'UTF-8')) {
                throw new InvalidArgumentException('DOCUMENT_EMPTY_OVERSIZED_OR_INVALID_ENCODING');
            }
            if (in_array($format, ['xml', 'oet', 'opt'], true)) {
                $document = self::xml($content);
                $parse = true;
                $executed[] = 'secure_xml_parse';
                $stages['parse'] = ['name' => 'parse', 'status' => 'PASS', 'scope' => 'XML well-formedness with external entities and DTDs prohibited', 'qualified' => false];
                if ($format === 'xml') {
                    $structure = true; // Legacy XML field means well-formedness only.
                    foreach (['structure', 'semantics', 'terminology', 'openehr_conformance'] as $name) {
                        $stages[$name] = ['name' => $name, 'status' => 'NOT_APPLICABLE', 'reason' => 'The generic XML operation requests well-formedness only.', 'qualified' => false];
                    }
                } else {
                    (new TemplateXmlProfile())->inspect($document, $format, $findings);
                    $structure = !$findings->failed();
                    $executed[] = $format . '_structural_profile';
                }
            } elseif (in_array($format, ['flat', 'structured'], true)) {
                $document = JsonDocument::parse($content);
                $parse = true;
                $executed[] = 'unambiguous_json_parse';
                $stages['parse'] = ['name' => 'parse', 'status' => 'PASS', 'scope' => 'Bounded JSON grammar and duplicate-key rejection', 'qualified' => false];
                (new SimplifiedDataProfile())->inspect($document, $format, $findings);
                $structure = !$findings->failed();
                $executed[] = $format . '_document_shape';
            } elseif ($format === 'adl') {
                $executed[] = 'adl_header_preflight';
                // Recognize a leading declaration only. Comments/body strings cannot stand in for it.
                if (!preg_match('/\A(?:\xEF\xBB\xBF)?(?:\s|--[^\r\n]*(?:\r?\n|$))*archetype\b(?:[ \t]*\([^\r\n()]{0,1000}\))?\s+(openEHR-[^\s;]+)(?:\s|$)/', $content, $matches)
                    || !preg_match(self::ARCHETYPE_ID, $matches[1])) {
                    $findings->add('error', 'ADL_DECLARATION_PREFLIGHT', '/', 'No supported leading ADL archetype declaration and identifier was found.', [], 'Provide a supported ADL source; grammar and specialised identifiers require the qualified engine.');
                }
                $findings->add('warning', 'ADL_GRAMMAR_NOT_EXECUTED', '/', 'A recognized header is not an ADL parse or model validation.', [], 'Run the qualified ADL/AOM/RM engine with dependencies.');
            }
        } catch (InvalidArgumentException|\JsonException $error) {
            $parse = false;
            $code = $error instanceof \JsonException ? 'JSON_MALFORMED' : explode(':', $error->getMessage(), 2)[0];
            $findings->add('error', $code, '/', 'The submitted document could not be safely parsed within the input profile.', [], 'Correct the syntax, encoding or size and remove unsafe or ambiguous constructs.');
            $stages['parse'] = ['name' => 'parse', 'status' => 'FAIL', 'scope' => 'Input safety and syntax', 'qualified' => false];
        }
        if ($structure !== null && $format !== 'xml') {
            $stages['structure'] = ['name' => 'structure', 'status' => $structure ? 'PASS' : 'FAIL', 'scope' => $format . '_bounded_document_profile', 'qualified' => false];
        }
        $items = $findings->all();
        $errors = array_values(array_map(static fn (array $finding): string => $finding['code'] . ': ' . $finding['message'], array_filter($items, static fn (array $finding): bool => $finding['severity'] === 'error')));
        $warnings = array_values(array_map(static fn (array $finding): string => $finding['message'], array_filter($items, static fn (array $finding): bool => $finding['severity'] === 'warning')));
        if ($format !== 'xml') {
            $warnings[] = 'Document profile checks do not establish semantic validity, terminology suitability, openEHR conformance or deployability.';
        }
        return ['valid' => $findings->failed() ? false : ($format === 'xml' ? true : null),
            'status' => $findings->failed() ? 'INVALID' : ($format === 'xml' ? 'VALIDATED' : ($executed === [] ? 'NOT_EXECUTED' : 'PARTIAL')),
            'parse_valid' => $parse, 'structurally_valid' => $structure, 'deterministic' => true,
            'scope' => $format === 'xml' ? 'xml_well_formedness' : $format . '_preflight',
            'validator' => 'openehr-modelling-document-profiles/2', 'executed_checks' => $executed,
            'stages' => array_values($stages), 'findings' => $items, 'errors' => $errors, 'warnings' => $warnings,
            'release_eligible' => false, 'content_sha256' => hash('sha256', $content), 'validated_at' => gmdate(DATE_ATOM)];
    }

    /** Semantic structural projection; addresses use parent placement + path + archetype, never XML order.
     *
     * @return array<string, array<string, mixed>>
     */
    public function projection(string $content): array
    {
        $document = self::xml($content);
        $result = [];
        $walk = function (DOMElement $element, string $parent) use (&$walk, &$result): void {
            $identity = $element->getAttribute('path') . '|' . $element->getAttribute('archetype_id');
            $key = $parent . '/' . $element->localName . '[' . $identity . ']';
            // Keep duplicate placements explicit rather than silently overwriting them.
            $base = $key;
            $n = 1;
            while (isset($result[$key])) {
                $key = $base . '#' . ++$n;
            }
            $attributes = [];
            foreach ($element->attributes as $attribute) {
                $attributes[$attribute->nodeName] = $attribute->nodeValue;
            }
            ksort($attributes);
            $text = '';
            foreach ($element->childNodes as $child) {
                if ($child instanceof \DOMText) {
                    $text .= $child->wholeText;
                }
            }
            $result[$key] = ['element' => $element->localName, 'attributes' => $attributes, 'text' => trim($text)];
            foreach ($element->childNodes as $child) {
                if ($child instanceof DOMElement) {
                    $walk($child, $key);
                }
            }
        };
        if ($document->documentElement !== null) {
            $walk($document->documentElement, '');
        }
        return $result;
    }

    /**
     * @return array<string, mixed> */
    public function diff(string $before, string $after): array
    {
        $a = $this->projection($before);
        $b = $this->projection($after);
        $changed = [];
        foreach (array_intersect_key($a, $b) as $path => $value) {
            if ($value !== $b[$path]) {
                $changed[$path] = ['before' => $value, 'after' => $b[$path]];
            }
        }
        $added = array_diff_key($b, $a);
        $removed = array_diff_key($a, $b);
        $semanticDifferences = [];
        $moved = $this->uniqueMoves($added, $removed);
        $movedAdded = array_fill_keys(array_column($moved, 'location'), true);
        $movedRemoved = array_fill_keys(array_column($moved, 'before_location'), true);
        foreach ($moved as $move) {
            $semanticDifferences[] = ['change' => 'moved', 'location' => $move['location'], 'before_location' => $move['before_location'],
                'dimension' => 'paths', 'identity' => $move['identity'], 'before' => $removed[$move['before_location']],
                'after' => $added[$move['location']]];
        }
        foreach ($added as $path => $value) {
            if (isset($movedAdded[$path])) {
                continue;
            }
            $semanticDifferences[] = ['change' => 'added', 'location' => $path, 'dimension' => $this->semanticDimension($value['element'], '', $value['text']), 'before' => null, 'after' => $value];
        }
        foreach ($removed as $path => $value) {
            if (isset($movedRemoved[$path])) {
                continue;
            }
            $semanticDifferences[] = ['change' => 'removed', 'location' => $path, 'dimension' => $this->semanticDimension($value['element'], '', $value['text']), 'before' => $value, 'after' => null];
        }
        foreach ($changed as $path => $delta) {
            $beforeValue = $delta['before'];
            $afterValue = $delta['after'];
            $attributes = array_unique(array_merge(array_keys($beforeValue['attributes']), array_keys($afterValue['attributes'])));
            foreach ($attributes as $attribute) {
                $attribute = (string) $attribute;
                $old = $beforeValue['attributes'][$attribute] ?? null;
                $new = $afterValue['attributes'][$attribute] ?? null;
                if ($old !== $new) {
                    $semanticDifferences[] = ['change' => 'modified', 'location' => $path, 'field' => $attribute,
                        'dimension' => $this->semanticDimension($afterValue['element'], $attribute, (string) ($new ?? $old)), 'before' => $old, 'after' => $new];
                }
            }
            if ($beforeValue['text'] !== $afterValue['text']) {
                $semanticDifferences[] = ['change' => 'modified', 'location' => $path, 'field' => 'text',
                    'dimension' => $this->semanticDimension($afterValue['element'], 'text', $afterValue['text']),
                    'before' => $beforeValue['text'], 'after' => $afterValue['text']];
            }
            if ($beforeValue['element'] !== $afterValue['element']) {
                $semanticDifferences[] = ['change' => 'modified', 'location' => $path, 'field' => 'element',
                    'dimension' => 'structure', 'before' => $beforeValue['element'], 'after' => $afterValue['element']];
            }
        }
        return ['scope' => 'bounded_xml_semantic_projection', 'status' => 'PARTIAL', 'added' => $added,
            'removed' => $removed, 'changed' => $changed, 'semantic_differences' => $semanticDifferences,
            'limitations' => ['This projection classifies explicit XML changes but does not resolve inherited constraints, dependencies, or prove full openEHR semantic equivalence.', 'Moves without a unique explicit archetype/node identity remain separate additions and removals.']];
    }

    /** @param array<string, array<string, mixed>> $added
     * @param array<string, array<string, mixed>> $removed
     * @return list<array{identity: string, location: string, before_location: string}> */
    private function uniqueMoves(array $added, array $removed): array
    {
        $index = static function (array $items): array {
            $byIdentity = [];
            foreach ($items as $location => $value) {
                $attributes = $value['attributes'];
                $archetype = $attributes['archetype_id'] ?? '';
                $node = $attributes['node_id'] ?? '';
                if ($archetype === '' && $node === '') {
                    continue;
                }
                $identity = json_encode([$value['element'], $archetype, $node], JSON_THROW_ON_ERROR);
                $byIdentity[$identity][] = (string) $location;
            }
            return $byIdentity;
        };
        $addedByIdentity = $index($added);
        $removedByIdentity = $index($removed);
        $moves = [];
        foreach ($removedByIdentity as $identity => $oldLocations) {
            $newLocations = $addedByIdentity[$identity] ?? [];
            if (count($oldLocations) === 1 && count($newLocations) === 1) {
                $moves[] = ['identity' => $identity, 'location' => $newLocations[0], 'before_location' => $oldLocations[0]];
            }
        }
        return $moves;
    }

    private function semanticDimension(string $element, string $field, string $value): string
    {
        $name = strtolower($element . ' ' . $field);
        if (preg_match('/(^|\s|_)(language|lang)(_|\s|$)/', $name)) {
            return 'languages';
        }
        if (str_contains($name, 'terminology') || str_contains($name, 'value_set') || str_contains($name, 'code_phrase') || str_contains($name, 'code_string')) {
            return 'terminology_bindings';
        }
        if (str_contains($name, 'slot') || str_contains($name, 'archetype_ref') || str_contains($name, 'include')) {
            return 'slots_and_dependencies';
        }
        if (str_contains($name, 'annotation') || str_contains($name, 'comment')) {
            return 'annotations';
        }
        if (str_contains($name, 'description') || in_array(strtolower($element), ['name', 'purpose', 'use', 'misuse', 'keywords'], true)) {
            return 'descriptions';
        }
        if (str_contains($name, 'occurrence') || str_contains($name, 'cardinality') || preg_match('/(^|\s)(min|max|lower|upper)(\s|$)/', $name)) {
            return 'occurrences_and_cardinalities';
        }
        if (str_contains($name, 'unit')) {
            return 'units';
        }
        if (str_contains($name, 'path')) {
            return 'paths';
        }
        if (str_contains($name, 'archetype_id') || str_contains($name, 'template_id') || str_contains($name, 'identifier')) {
            return 'archetype_identifiers';
        }
        if (str_contains($name, 'node_id') || preg_match('/\bat[0-9]{4,}\b/', $value)) {
            return 'node_identifiers';
        }
        if (str_contains($name, 'rm_type') || str_contains($name, 'xsi:type')) {
            return 'rm_types';
        }
        if (str_starts_with(strtolower($element), 'c_') || str_contains($name, 'constraint') || str_contains($name, 'rule')) {
            return 'constraints';
        }
        return 'structure_or_unclassified';
    }
}
