<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Helpers;

/** Shared error envelope for new deterministic services; legacy tool contracts remain intact. */
final class ToolResult
{
    public const array SCHEMA = [
        'type' => 'object', 'additionalProperties' => false, 'required' => ['success', 'result', 'error'],
        'properties' => [
            'success' => ['type' => 'boolean'], 'result' => ['type' => ['object', 'null']],
            'error' => ['type' => ['object', 'null'], 'additionalProperties' => false,
                'required' => ['code', 'message', 'retryable'], 'properties' => [
                    'code' => ['type' => 'string'], 'message' => ['type' => 'string'], 'retryable' => ['type' => 'boolean'],
                ]],
        ],
    ];

    /**
     * @param callable(): array<string, mixed> $operation
     * @return array<string, mixed> */
    public static function run(callable $operation): array
    {
        try {
            return ['success' => true, 'result' => $operation(), 'error' => null];
        } catch (\Throwable $e) {
            $code = match (true) {
                $e instanceof \InvalidArgumentException => 'INVALID_INPUT',
                $e instanceof \DomainException => 'GOVERNANCE_REJECTED',
                default => 'OPERATION_FAILED',
            };
            // Only fixed uppercase domain error identifiers are safe to pass through.
            if (preg_match('/^[A-Z][A-Z0-9_]{2,80}$/D', $e->getMessage())) {
                $code = $e->getMessage();
            }
            return ['success' => false, 'result' => null, 'error' => ['code' => $code,
                'message' => match ($code) {
                    'INVALID_INPUT' => 'Input does not meet the documented operation constraints.',
                    'REVISION_CONFLICT' => 'The artefact changed. Read the current revision before retrying.',
                    'WRITES_DISABLED' => 'Repository writes are disabled by deployment configuration.',
                    'CDR_BROWSER_ONLY' => 'Patient-data protection: execution, query history and saved query contents are available only in the AQL workspace. The assistant can draft and validate queries; use Run query yourself.',
                    default => 'The operation could not be completed. Check the identifier, configuration and dependency availability.',
                }, 'retryable' => $code === 'OPERATION_FAILED']];
        }
    }
}
