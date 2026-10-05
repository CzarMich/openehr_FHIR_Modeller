<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Repository;

/** Byte-preserving JSON representation. Binary originals never masquerade as editable text. */
final class OriginalContent
{
    public const int MAX_BYTES = 2097152;

    public static function isOriginal(string $path): bool
    {
        return str_starts_with($path, 'originals/');
    }

    public static function path(string $id, string $filename): string
    {
        if (!preg_match('/^[a-f0-9]{64}$/D', $id) || $filename === '' || strlen($filename) > 128
            || !mb_check_encoding($filename, 'UTF-8') || preg_match('~[\x00-\x1f\x7f/\\\\%]~u', $filename)
            || in_array($filename, ['.', '..'], true)) {
            throw new \InvalidArgumentException('IMPORT_FILENAME_OR_ID_INVALID');
        }
        return 'originals/' . $id . '/' . $filename;
    }

    public static function assertPath(string $path): void
    {
        $parts = explode('/', $path);
        if (count($parts) !== 3 || $parts[0] !== 'originals' || self::path($parts[1], $parts[2]) !== $path) {
            throw new \InvalidArgumentException('IMPORT_ORIGINAL_PATH_INVALID');
        }
    }

    /** @return array<string, mixed> */
    public static function envelope(string $bytes): array
    {
        if (strlen($bytes) > self::MAX_BYTES) {
            throw new \InvalidArgumentException('ARTIFACT_TOO_LARGE');
        }
        $text = mb_check_encoding($bytes, 'UTF-8') && !str_contains($bytes, "\0");
        return ['content' => $text ? $bytes : null, 'content_base64' => $text ? null : base64_encode($bytes),
            'content_encoding' => $text ? 'utf8' : 'base64', 'sha256' => hash('sha256', $bytes), 'size_bytes' => strlen($bytes)];
    }

    /** @param array<string, mixed> $artifact */
    public static function bytes(array $artifact): string
    {
        $bytes = $artifact['content'] ?? null;
        if (($artifact['content_encoding'] ?? null) === 'base64') {
            $encoded = $artifact['content_base64'] ?? null;
            $bytes = is_string($encoded) ? base64_decode($encoded, true) : false;
            if ($bytes === false || base64_encode($bytes) !== $encoded) {
                throw new \RuntimeException('IMPORT_ORIGINAL_INTEGRITY_FAILED');
            }
        }
        if (!is_string($bytes) || strlen($bytes) > self::MAX_BYTES || !is_string($artifact['sha256'] ?? null)
            || !hash_equals($artifact['sha256'], hash('sha256', $bytes))) {
            throw new \RuntimeException('IMPORT_ORIGINAL_INTEGRITY_FAILED');
        }
        return $bytes;
    }
}
