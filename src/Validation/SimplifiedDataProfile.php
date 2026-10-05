<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Validation;

/** Document shape only. Web Template paths, RM values and cardinalities need an OPT. */
final class SimplifiedDataProfile
{
    private const string SEGMENT = '[\p{L}\p{M}_][\p{L}\p{M}\p{N}_.-]*(?::(?:0|[1-9][0-9]{0,9}))?';
    private const string SUFFIX = '[a-zA-Z_][a-zA-Z_0-9]*';

    public function inspect(mixed $value, string $format, Findings $findings): void
    {
        if (!$value instanceof \stdClass || get_object_vars($value) === []) {
            $this->error($findings, 'SIMPLIFIED_ROOT', '/', 'A nonempty JSON object is required.');
            return;
        }
        if ($format === 'flat') {
            foreach (get_object_vars($value) as $key => $item) {
                $key = (string) $key;
                $location = '/' . self::escape($key);
                if (strlen($key) > 2000 || !preg_match('~^' . self::SEGMENT . '(?:/' . self::SEGMENT . ')*(?:\|' . self::SUFFIX . ')?$~uD', $key)) {
                    $this->error($findings, 'FLAT_FIELD_IDENTIFIER', $location, 'The field identifier does not match the bounded FLAT syntax profile.');
                }
                if (str_ends_with($key, '|raw')) {
                    $this->raw($item, $location, $findings);
                } elseif (!is_scalar($item) && $item !== null) {
                    $this->error($findings, 'FLAT_VALUE_SHAPE', $location, 'Ordinary FLAT fields require scalar or null values; raw objects use |raw.');
                } elseif (is_float($item) && !is_finite($item)) {
                    $this->error($findings, 'JSON_NUMBER_RANGE', $location, 'The number cannot be represented as a finite runtime value.');
                }
            }
            return;
        }
        foreach (get_object_vars($value) as $key => $item) {
            $key = (string) $key;
            $location = '/' . self::escape($key);
            $this->key($key, $location, false, $findings);
            if (!$item instanceof \stdClass) {
                $this->error($findings, 'STRUCTURED_ROOT_VALUE', $location, 'Composition and ctx roots require JSON objects.');
            } else {
                $this->object($item, $location, $key === 'ctx', $findings);
            }
        }
    }

    private function object(\stdClass $object, string $location, bool $context, Findings $findings): void
    {
        if (get_object_vars($object) === []) {
            $findings->add('warning', 'EMPTY_STRUCTURED_OBJECT', $location, 'Empty structured objects should be omitted.', [], 'Omit empty objects or provide the intended values.');
        }
        foreach (get_object_vars($object) as $key => $item) {
            $key = (string) $key;
            $at = $location . '/' . self::escape($key);
            $this->key($key, $at, true, $findings);
            if ($key === '|raw') {
                $this->raw($item, $at, $findings);
            } elseif (str_starts_with($key, '|') || ($context && !is_array($item) && !$item instanceof \stdClass)) {
                if (!is_scalar($item) && $item !== null) {
                    $this->error($findings, 'STRUCTURED_ATTRIBUTE_VALUE', $at, 'Attribute suffixes require scalar or null values in this profile.');
                } elseif (is_float($item) && !is_finite($item)) {
                    $this->error($findings, 'JSON_NUMBER_RANGE', $at, 'The number cannot be represented as a finite runtime value.');
                }
            } elseif ($context && $item instanceof \stdClass) {
                $this->object($item, $at, true, $findings);
            } elseif (!is_array($item)) {
                $this->error($findings, 'STRUCTURED_NODE_ARRAY', $at, 'Data node values require arrays, including single occurrences.');
            } else {
                foreach ($item as $index => $child) {
                    if ($child instanceof \stdClass) {
                        $this->object($child, $at . '/' . $index, $context, $findings);
                    } elseif (is_array($child)) {
                        $this->error($findings, 'STRUCTURED_NESTED_ARRAY', $at . '/' . $index, 'An occurrence must be an object, scalar or null, not another array.');
                    } elseif (is_float($child) && !is_finite($child)) {
                        $this->error($findings, 'JSON_NUMBER_RANGE', $at . '/' . $index, 'The number cannot be represented as a finite runtime value.');
                    }
                }
            }
        }
    }

    private function key(string $key, string $location, bool $suffix, Findings $findings): void
    {
        if (strlen($key) > 300 || !preg_match('~^(?:' . self::SEGMENT . ($suffix ? '|\|' . self::SUFFIX : '') . ')$~uD', $key)) {
            $this->error($findings, 'STRUCTURED_FIELD_IDENTIFIER', $location, 'Use one node identifier or a separate pipe-prefixed attribute; slash paths belong to FLAT.');
        }
    }

    private function raw(mixed $value, string $location, Findings $findings): void
    {
        if (is_string($value)) {
            try {
                $value = JsonDocument::parse($value);
                $findings->add('warning', 'LEGACY_STRINGIFIED_RAW', $location, 'A provider compatibility form contains serialized raw JSON.', [], 'Prefer an object for the development specification profile; verify the target CDR format.');
            } catch (\InvalidArgumentException|\JsonException) {
                $this->error($findings, 'RAW_JSON_INVALID', $location, 'The serialized raw value is malformed or ambiguous JSON.');
                return;
            }
        }
        if (!$value instanceof \stdClass || !isset($value->_type) || !is_string($value->_type) || !preg_match('/^[A-Z][A-Z0-9_]{0,99}$/D', $value->_type)) {
            $this->error($findings, 'RAW_TYPE_REQUIRED', $location, 'A raw value requires a JSON object with an explicit _type.');
        }
        // Deliberately do not certify RM properties, types, values or template compatibility.
    }

    private function error(Findings $findings, string $code, string $location, string $message): void
    {
        $findings->add('error', $code, $location, $message, [], 'Correct the document shape using the selected simplified format and its Web Template.');
    }

    private static function escape(string $key): string
    {
        return str_replace(['~', '/'], ['~0', '~1'], $key);
    }
}
