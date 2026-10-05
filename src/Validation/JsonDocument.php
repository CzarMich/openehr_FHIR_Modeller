<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Validation;

/** Native JSON parsing plus bounded duplicate-key rejection for unambiguous references. */
final class JsonDocument
{
    public static function parse(string $content, int $maxBytes = 2097152, int $maxTokens = 100000): mixed
    {
        if ($maxBytes < 1 || $maxBytes > 16777216 || $maxTokens < 1 || $maxTokens > 1000000 || strlen($content) > $maxBytes) {
            throw new \InvalidArgumentException('JSON_DOCUMENT_TOO_LARGE');
        }
        $value = json_decode($content, false, 64, JSON_THROW_ON_ERROR);
        // Native parsing validates the grammar first. This scan tracks object keys only;
        // strings are decoded with the native parser so escaped aliases compare equally.
        $stack = [];
        $tokens = 0;
        $length = strlen($content);
        for ($offset = 0; $offset < $length; ++$offset) {
            $token = $content[$offset];
            if (!str_contains('"{}[]:,', $token)) {
                continue;
            }
            if (++$tokens > $maxTokens) {
                throw new \InvalidArgumentException('JSON_DOCUMENT_TOKEN_LIMIT');
            }
            if ($token === '{' || $token === '[') {
                $stack[] = ['object' => $token === '{', 'keys' => []];
            } elseif ($token === '}' || $token === ']') {
                array_pop($stack);
            } elseif ($token === '"') {
                $start = $offset++;
                // Native decoding above guarantees a closing quote and valid escapes.
                // Scan complete string runs without regex recursion/JIT stack limits.
                while ($offset < $length) {
                    $offset += strcspn($content, "\"\\", $offset);
                    if ($content[$offset] === '"') {
                        break;
                    }
                    $offset += 2;
                }
                $next = $offset + 1;
                $next += strspn($content, " \t\r\n", $next);
                if (($content[$next] ?? '') !== ':') {
                    continue;
                }
                $at = count($stack) - 1;
                if ($at < 0 || !$stack[$at]['object']) {
                    throw new \InvalidArgumentException('INVALID_JSON_OBJECT');
                }
                $key = json_decode(substr($content, $start, $offset - $start + 1), true, 2, JSON_THROW_ON_ERROR);
                if (isset($stack[$at]['keys'][$key])) {
                    throw new \InvalidArgumentException('DUPLICATE_JSON_KEY');
                }
                $stack[$at]['keys'][$key] = true;
            }
        }
        return $value;
    }
}
