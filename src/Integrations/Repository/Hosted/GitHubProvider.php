<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Repository\Hosted;

use OpenEHR\Assistant\Domain\Repository\HostedRepositoryProvider;

final readonly class GitHubProvider implements HostedRepositoryProvider
{
    /** @var list<string> */
    private array $path;

    public function __construct(private HostedApi $api, private string $repository, private string $host)
    {
        $this->path = ['repos', ...explode('/', $repository)];
    }

    public function metadata(): array
    {
        $data = $this->api->request('GET', $this->path);
        return ['provider' => 'github', 'repository' => $this->repository,
            'url' => HostedInput::link($data['html_url'] ?? null, $this->host),
            'default_branch' => HostedInput::text($data, 'default_branch'),
            'private' => is_bool($data['private'] ?? null) ? $data['private'] : null,
            'archived' => is_bool($data['archived'] ?? null) ? $data['archived'] : null];
    }

    public function branches(int $page = 1): array
    {
        HostedInput::page($page);
        $data = $this->api->request('GET', [...$this->path, 'branches'], ['per_page' => 100, 'page' => $page]);
        if (!array_is_list($data) || count($data) > 100) { throw new \RuntimeException('HOSTED_INVALID_RESPONSE'); }
        $branches = [];
        foreach ($data as $item) {
            if (!is_array($item) || !is_array($item['commit'] ?? null)) { throw new \RuntimeException('HOSTED_INVALID_RESPONSE'); }
            $branches[] = ['name' => HostedInput::text($item, 'name'), 'revision' => HostedInput::text($item['commit'], 'sha'),
                'protected' => is_bool($item['protected'] ?? null) ? $item['protected'] : null];
        }
        return ['branches' => $branches, 'page' => $page, 'next_page' => count($data) === 100 ? $page + 1 : null];
    }

    public function review(int $number): array
    {
        HostedInput::number($number);
        return $this->normalize($this->api->request('GET', [...$this->path, 'pulls', (string) $number]));
    }

    public function requestReview(string $branch, string $target, string $title, string $body): array
    {
        HostedInput::review($branch, $target, $title, $body);
        $existing = $this->api->request('GET', [...$this->path, 'pulls'], ['state' => 'open',
            'head' => explode('/', $this->repository)[0] . ':' . $branch, 'base' => $target, 'per_page' => 100]);
        if (!array_is_list($existing)) { throw new \RuntimeException('HOSTED_INVALID_RESPONSE'); }
        foreach ($existing as $item) {
            if (!is_array($item)) { throw new \RuntimeException('HOSTED_INVALID_RESPONSE'); }
            if (($item['head']['ref'] ?? null) === $branch && ($item['base']['ref'] ?? null) === $target
                && strcasecmp((string) ($item['head']['repo']['full_name'] ?? ''), $this->repository) === 0) {
                return $this->normalize($item) + ['created' => false];
            }
        }
        $data = $this->api->request('POST', [...$this->path, 'pulls'], [], ['head' => $branch, 'base' => $target,
            'title' => $title, 'body' => $body, 'draft' => true, 'maintainer_can_modify' => false]);
        return $this->normalize($data) + ['created' => true];
    }

    /** @param array<mixed> $data
     * @return array<string, mixed> */
    private function normalize(array $data): array
    {
        if (!is_int($data['number'] ?? null) || !is_array($data['head'] ?? null) || !is_array($data['base'] ?? null)) {
            throw new \RuntimeException('HOSTED_INVALID_RESPONSE');
        }
        return ['provider' => 'github', 'number' => $data['number'], 'url' => HostedInput::link($data['html_url'] ?? null, $this->host),
            'title' => HostedInput::text($data, 'title'), 'state' => HostedInput::text($data, 'state'),
            'draft' => is_bool($data['draft'] ?? null) ? $data['draft'] : null,
            'source_branch' => HostedInput::text($data['head'], 'ref'), 'target_branch' => HostedInput::text($data['base'], 'ref'),
            'source_revision' => HostedInput::text($data['head'], 'sha'), 'target_revision' => HostedInput::text($data['base'], 'sha'),
            'merged' => is_bool($data['merged'] ?? null) ? $data['merged'] : null,
            'clinical_approval' => false];
    }
}
