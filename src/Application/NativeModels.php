<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Application;

use OpenEHR\Assistant\Domain\Modelling\OpenEhrEngine;

/** Shared application boundary for native validation, inspection and compilation. */
final readonly class NativeModels
{
    public function __construct(private OpenEhrEngine $engine)
    {
    }

    /** @param list<array{identifier: string, content: string}> $dependencies
     * @return array<string, mixed> */
    public function validate(string $content, string $format, array $dependencies = []): array
    {
        self::content($content);
        return $this->engine->validate($content, $format, self::dependencies($dependencies));
    }

    /** @param list<array{identifier: string, content: string}> $dependencies
     * @return array<string, mixed> */
    public function compile(string $content, array $dependencies): array
    {
        self::content($content);
        return $this->engine->compile($content, self::dependencies($dependencies));
    }

    /** @param list<array{identifier: string, content: string}> $dependencies
     * @return array<string, mixed> */
    public function inspect(string $content, string $format, array $dependencies = []): array
    {
        self::content($content);
        return $this->engine->inspect($content, $format, self::dependencies($dependencies));
    }

    /** @param array<mixed> $dependencies
     * @return list<array{identifier: string, content: string, sha256: string}> */
    private static function dependencies(array $dependencies): array
    {
        if (!array_is_list($dependencies) || count($dependencies) > 64) {
            throw new \InvalidArgumentException('ENGINE_DEPENDENCY_LIMIT');
        }
        $result = [];
        $seen = [];
        foreach ($dependencies as $dependency) {
            if (!is_array($dependency) || array_diff(array_keys($dependency), ['identifier', 'content']) !== []
                || !is_string($dependency['identifier'] ?? null) || !is_string($dependency['content'] ?? null)
                || !preg_match('/^[A-Za-z0-9][A-Za-z0-9_.:-]{1,299}$/D', $dependency['identifier'])) {
                throw new \InvalidArgumentException('ENGINE_INVALID_DEPENDENCY');
            }
            self::content($dependency['content']);
            if (isset($seen[$dependency['identifier']])) {
                throw new \InvalidArgumentException('ENGINE_DEPENDENCY_AMBIGUOUS');
            }
            $seen[$dependency['identifier']] = true;
            $result[] = ['identifier' => $dependency['identifier'], 'content' => $dependency['content'],
                'sha256' => hash('sha256', $dependency['content'])];
        }
        usort($result, static fn (array $a, array $b): int => strcmp($a['identifier'], $b['identifier']));
        return $result;
    }

    private static function content(string $content): void
    {
        if (trim($content) === '' || strlen($content) > 2097152 || str_contains($content, "\0") || !mb_check_encoding($content, 'UTF-8')) {
            throw new \InvalidArgumentException('ENGINE_INVALID_DOCUMENT');
        }
    }
}
