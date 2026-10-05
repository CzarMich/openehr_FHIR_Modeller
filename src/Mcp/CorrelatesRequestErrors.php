<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Mcp;

use Symfony\Component\Uid\Uuid;

/** SDK integration only: preserve its authentication, sessions, dispatch and framing. */
trait CorrelatesRequestErrors
{
    /** @var list<string|int> */
    private array $unknownRequestIds = [];

    protected function handleMessage(string $payload, ?Uuid $sessionId): void
    {
        $this->unknownRequestIds = RequestErrors::unknownIds($payload);
        parent::handleMessage($payload, $sessionId);
    }

    /** @param array<string, mixed> $context */
    public function send(string $data, array $context): void
    {
        parent::send(RequestErrors::normalize($data, $this->unknownRequestIds), $context);
    }

    /** @return array<int, array{message: string, context: array<string, mixed>}> */
    protected function getOutgoingMessages(?Uuid $sessionId): array
    {
        $messages = parent::getOutgoingMessages($sessionId);
        foreach ($messages as &$message) {
            $message['message'] = RequestErrors::normalize($message['message'], $this->unknownRequestIds);
        }
        return $messages;
    }
}
