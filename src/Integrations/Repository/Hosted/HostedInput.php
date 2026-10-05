<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Repository\Hosted;

final class HostedInput
{
    public static function branch(string $branch): void
    {
        if (strlen($branch) > 200 || !preg_match('~^[A-Za-z0-9][A-Za-z0-9._/-]*$~D', $branch)
            || str_contains($branch, '..') || str_contains($branch, '//') || str_ends_with($branch, '/')
            || str_ends_with($branch, '.') || str_ends_with($branch, '.lock') || preg_match('~(^|/)\.~', $branch)) {
            throw new \InvalidArgumentException('INVALID_GIT_BRANCH');
        }
    }

    public static function review(string $branch, string $target, string $title, string $body): void
    {
        self::branch($branch); self::branch($target);
        if ($branch === $target || trim($title) === '' || strlen($title) > 200 || strlen($body) > 20000
            || preg_match('/[\x00-\x1f\x7f]/', $title) || str_contains($body, "\0")) {
            throw new \InvalidArgumentException('INVALID_REVIEW_REQUEST');
        }
    }

    public static function page(int $page): void
    {
        if ($page < 1 || $page > 10000) { throw new \InvalidArgumentException('INVALID_PAGE'); }
    }

    public static function number(int $number): void
    {
        if ($number < 1) { throw new \InvalidArgumentException('INVALID_REVIEW_NUMBER'); }
    }

    /** Returned browser links must point to the configured repository host, never an arbitrary origin. */
    public static function link(mixed $url, string $host): string
    {
        if (!is_string($url)) { throw new \RuntimeException('HOSTED_INVALID_RESPONSE'); }
        try { \OpenEHR\Assistant\Configuration\Settings::validateUrl($url); }
        catch (\InvalidArgumentException) { throw new \RuntimeException('HOSTED_INVALID_RESPONSE'); }
        if (strtolower((string) parse_url($url, PHP_URL_HOST)) !== strtolower($host)) { throw new \RuntimeException('HOSTED_INVALID_RESPONSE'); }
        return $url;
    }

    /** @param array<mixed> $value */
    public static function text(array $value, string $key): string
    {
        if (!isset($value[$key]) || !is_string($value[$key])) { throw new \RuntimeException('HOSTED_INVALID_RESPONSE'); }
        return $value[$key];
    }
}
