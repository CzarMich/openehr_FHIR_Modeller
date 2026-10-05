<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Validation;

use DOMDocument;
use DOMElement;

/** Explicit OET/OPT document checks; does not replace schemas or an AOM/RM engine. */
final class TemplateXmlProfile
{
    public function inspect(DOMDocument $document, string $format, Findings $findings): void
    {
        $root = $document->documentElement;
        $namespaces = $format === 'oet' ? ['openEHR/v1/Template'] : ['http://schemas.openehr.org/v1', 'http://schemas.openehr.org/v2'];
        if (!$root || $root->localName !== 'template' || !in_array($root->namespaceURI, $namespaces, true)) {
            $this->error($findings, 'TEMPLATE_ROOT', '/1', 'Unexpected template root or namespace for the selected profile.');
            return;
        }
        foreach ($format === 'oet' ? ['id', 'name', 'definition'] : ['template_id', 'definition', 'language', 'concept'] as $name) {
            $children = self::children($root, $name);
            if (count($children) !== 1) {
                $this->error($findings, 'TEMPLATE_REQUIRED_ELEMENT', '/1', 'Exactly one ' . $name . ' element is required by this profile.');
            } elseif (in_array($name, ['id', 'name', 'template_id', 'concept'], true) && trim($children[0]->textContent) === '') {
                $this->error($findings, 'TEMPLATE_EMPTY_IDENTITY', '/1', 'The ' . $name . ' value must not be empty.');
            }
        }
        $descriptions = self::children($root, 'description');
        if ($descriptions === [] || trim($descriptions[0]->textContent) === '') {
            $findings->add('warning', 'MISSING_DESCRIPTION', '/1', 'The template has no nonempty description.', [], 'Record its purpose, intended use and clinical scope for review.');
        }
        $definition = self::children($root, 'definition')[0] ?? null;
        foreach (XmlLocations::index($document) as $location => $node) {
            if ($node->namespaceURI !== $root->namespaceURI) {
                // Extension content may be legal under other profiles; require an explicit review.
                $findings->add('warning', 'UNASSESSED_XML_NAMESPACE', $location, 'This profile does not assess elements in another namespace.', [], 'Validate the extension with its schema and the qualified engine.');
                continue;
            }
            if ($format === 'oet') {
                if ($node === $definition && !$node->hasAttribute('archetype_id')) {
                    $this->error($findings, 'MISSING_ARCHETYPE_REFERENCE', $location, 'The OET definition requires an archetype reference.');
                }
                if ($node !== $definition && in_array($node->localName, ['Content', 'Item', 'Items'], true) && !$node->hasAttribute('archetype_id')) {
                    $this->error($findings, 'MISSING_ARCHETYPE_REFERENCE', $location, 'An OET placement requires an archetype reference.');
                }
                if ($node->hasAttribute('archetype_id') && !preg_match(ModelValidator::ARCHETYPE_ID, $node->getAttribute('archetype_id'))) {
                    $this->error($findings, 'INVALID_ARCHETYPE_REFERENCE', $location, 'The archetype identifier does not match the supported identifier profile.');
                }
                if ($node === $definition || in_array($node->localName, ['Content', 'Item', 'Items'], true)) {
                    $rmType = $this->oetType($node, $location, $findings);
                    if ($node === $definition && $rmType !== 'COMPOSITION') {
                        $this->error($findings, 'OET_ROOT_TYPE_INVALID', $location, 'The OET definition must be typed as COMPOSITION.');
                    }
                    if ($node->hasAttribute('archetype_id') && preg_match('/^openEHR-[A-Z_]+-([A-Z_]+)\./', $node->getAttribute('archetype_id'), $match)
                        && $rmType !== null && $rmType !== $match[1]) {
                        $this->error($findings, 'OET_RM_TYPE_REFERENCE_MISMATCH', $location, 'The OET xsi:type does not match the archetype identifier RM class.');
                    }
                    if ($node !== $definition) {
                        $parentType = $node->parentNode instanceof DOMElement ? $this->oetType($node->parentNode, $location, $findings) : null;
                        $expectedElement = match ($parentType) {
                            'COMPOSITION' => 'Content',
                            'SECTION' => 'Item',
                            'OBSERVATION', 'EVALUATION', 'INSTRUCTION', 'ACTION', 'ADMIN_ENTRY', 'CLUSTER' => 'Items',
                            default => null,
                        };
                        if ($expectedElement === null || $node->localName !== $expectedElement) {
                            $this->error($findings, 'OET_PLACEMENT_KIND_INVALID', $location, 'The OET placement element does not match its parent RM type.');
                        }
                    }
                }
                $this->attributeBounds($node, $location, $findings);
                if ($node->localName === 'Rule' && (!$node->hasAttribute('path') || !str_starts_with($node->getAttribute('path'), '/'))) {
                    $this->error($findings, 'INVALID_RULE_PATH', $location, 'A rule requires an absolute path relative to its archetype.');
                }
                if ($node->hasAttribute('path') && preg_match('/[\x00-\x1f\x7f]/', $node->getAttribute('path'))) {
                    $this->error($findings, 'INVALID_RULE_PATH', $location, 'A model path must not contain control characters.');
                }
            } else {
                if ($node->localName === 'archetype_id' && !preg_match(ModelValidator::ARCHETYPE_ID, trim($node->textContent))) {
                    $this->error($findings, 'INVALID_ARCHETYPE_REFERENCE', $location, 'The archetype identifier does not match the supported identifier profile.');
                }
                if ($node->localName === 'rm_type_name' && !preg_match('/^[A-Z][A-Z0-9_]{0,99}$/D', trim($node->textContent))) {
                    $this->error($findings, 'INVALID_RM_TYPE_SYNTAX', $location, 'The RM type name is empty or malformed; RM membership is a separate check.');
                }
                if (in_array($node->localName, ['occurrences', 'existence'], true)
                    || ($node->localName === 'interval' && $node->parentNode instanceof DOMElement && $node->parentNode->localName === 'cardinality')) {
                    $this->interval($node, $location, $findings);
                }
            }
        }
    }

    private function attributeBounds(DOMElement $node, string $location, Findings $findings): void
    {
        foreach (['min', 'max'] as $bound) {
            if ($node->hasAttribute($bound) && !preg_match($bound === 'min' ? '/^[0-9]+$/D' : '/^(?:[0-9]+|\*)$/D', $node->getAttribute($bound))) {
                $this->error($findings, 'INVALID_OCCURRENCE_BOUND', $location, 'The occurrence bound is outside this nonnegative/asterisk profile.');
            }
        }
        if ($node->hasAttribute('min') && $node->hasAttribute('max') && ctype_digit($node->getAttribute('min'))
            && ctype_digit($node->getAttribute('max')) && self::greater($node->getAttribute('min'), $node->getAttribute('max'))) {
            $this->error($findings, 'REVERSED_OCCURRENCES', $location, 'The minimum occurrence exceeds the maximum.');
        }
    }

    private function interval(DOMElement $node, string $location, Findings $findings): void
    {
        $values = [];
        foreach (['lower', 'upper', 'lower_unbounded', 'upper_unbounded', 'lower_included', 'upper_included'] as $name) {
            $parts = self::children($node, $name);
            if (count($parts) > 1) {
                $this->error($findings, 'DUPLICATE_INTERVAL_FIELD', $location, 'The interval repeats a bound or flag.');
            }
            if ($parts !== []) {
                $values[$name] = trim($parts[0]->textContent);
            }
        }
        foreach (['lower', 'upper'] as $bound) {
            $unbounded = in_array($values[$bound . '_unbounded'] ?? 'false', ['true', '1'], true);
            if (isset($values[$bound]) && (!ctype_digit($values[$bound]) || $unbounded)) {
                $this->error($findings, 'INVALID_INTERVAL_BOUND', $location, 'An occurrence/cardinality bound must be nonnegative and consistent with its unbounded flag.');
            } elseif (!isset($values[$bound]) && !$unbounded) {
                $this->error($findings, 'MISSING_INTERVAL_BOUND', $location, 'Provide a bound or an explicit unbounded flag.');
            }
            foreach (['_unbounded', '_included'] as $flag) {
                if (isset($values[$bound . $flag]) && !in_array($values[$bound . $flag], ['true', 'false', '1', '0'], true)) {
                    $this->error($findings, 'INVALID_INTERVAL_FLAG', $location, 'Interval flags require XML boolean values.');
                }
            }
        }
        if (isset($values['lower'], $values['upper']) && ctype_digit($values['lower']) && ctype_digit($values['upper'])
            && self::greater($values['lower'], $values['upper'])) {
            $this->error($findings, 'REVERSED_INTERVAL', $location, 'The interval lower bound exceeds its upper bound.');
        }
    }

    /** Decimal comparison without integer overflow. */
    private static function greater(string $left, string $right): bool
    {
        $left = ltrim($left, '0');
        $right = ltrim($right, '0');
        return strlen($left) === strlen($right) ? strcmp($left, $right) > 0 : strlen($left) > strlen($right);
    }

    /** @return list<DOMElement> */
    private static function children(DOMElement $parent, string $name): array
    {
        $result = [];
        foreach ($parent->childNodes as $child) {
            if ($child instanceof DOMElement && $child->namespaceURI === $parent->namespaceURI && $child->localName === $name) {
                $result[] = $child;
            }
        }
        return $result;
    }

    private function error(Findings $findings, string $code, string $location, string $message): void
    {
        $findings->add('error', $code, $location, $message, [], 'Correct the source constraint and rerun validation; use the qualified engine for full model checks.');
    }

    private function oetType(DOMElement $element, string $location, Findings $findings): ?string
    {
        $type = $element->getAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'type');
        if ($type === '' || !preg_match('/^(?:[A-Za-z_][A-Za-z0-9_.-]*:)?([A-Z][A-Z0-9_]*)$/D', $type, $match)) {
            $this->error($findings, 'OET_RM_TYPE_MISSING_OR_INVALID', $location, 'The OET definition or placement requires a supported xsi:type.');
            return null;
        }
        if (str_contains($type, ':')) {
            [$prefix] = explode(':', $type, 2);
            if ($element->lookupNamespaceURI($prefix) !== $element->namespaceURI) {
                $this->error($findings, 'OET_RM_TYPE_NAMESPACE_INVALID', $location, 'The OET xsi:type prefix must resolve to the template namespace.');
                return null;
            }
        }
        return $match[1];
    }
}
