<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Mcp;

/** Narrow SDK 0.8 compatibility: unknown methods use JSON-RPC -32601, not -32600. */
final class RequestErrors
{
    private const METHODS = ['initialize', 'ping', 'tools/list', 'tools/call', 'prompts/list', 'prompts/get',
        'resources/list', 'resources/templates/list', 'resources/read', 'resources/subscribe', 'resources/unsubscribe',
        'completion/complete', 'logging/setLevel'];

    /** @return list<string|int> */
    public static function unknownIds(string $payload): array
    {
        try {
            $input = json_decode($payload, false, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return [];
        }
        $ids = [];
        foreach (is_array($input) ? $input : [$input] as $message) {
            if ($message instanceof \stdClass && ($message->jsonrpc ?? null) === '2.0'
                && is_string($message->method ?? null) && !in_array($message->method, self::METHODS, true)
                && (is_string($message->id ?? null) || is_int($message->id ?? null))
                && !property_exists($message, 'result') && !property_exists($message, 'error')) {
                $ids[] = $message->id;
            }
        }
        return $ids;
    }

    /** @param list<string|int> $unknownIds */
    public static function normalize(string $response, array $unknownIds): string
    {
        if ($unknownIds === []) {
            return $response;
        }
        $data = json_decode($response, true);
        if (!is_array($data) || ($data['error']['code'] ?? null) !== -32600
            || !in_array($data['id'] ?? null, $unknownIds, true)) {
            return $response;
        }
        $data['error'] = ['code' => -32601, 'message' => 'Method not found'];
        return json_encode($data, JSON_THROW_ON_ERROR);
    }
}
