<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Repository\Hosted;

use OpenEHR\Assistant\Domain\Repository\HostedRepositoryProvider;

final readonly class GitLabProvider implements HostedRepositoryProvider
{
    /** @var list<string> */
    private array $path;

    public function __construct(private HostedApi $api, private string $repository, private string $host)
    {
        $this->path = ['projects', $repository];
    }

    public function metadata(): array
    {
        $data = $this->api->request('GET', $this->path);
        return ['provider' => 'gitlab', 'repository' => $this->repository,
            'url' => HostedInput::link($data['web_url'] ?? null, $this->host),
            'default_branch' => HostedInput::text($data, 'default_branch'),
            'visibility' => HostedInput::text($data, 'visibility'),
            'archived' => is_bool($data['archived'] ?? null) ? $data['archived'] : null];
    }

    public function branches(int $page = 1): array
    {
        HostedInput::page($page);
        $data = $this->api->request('GET', [...$this->path, 'repository', 'branches'], ['per_page' => 100, 'page' => $page]);
        if (!array_is_list($data) || count($data) > 100) { throw new \RuntimeException('HOSTED_INVALID_RESPONSE'); }
        $branches = [];
        foreach ($data as $item) {
            if (!is_array($item) || !is_array($item['commit'] ?? null)) { throw new \RuntimeException('HOSTED_INVALID_RESPONSE'); }
            $branches[] = ['name' => HostedInput::text($item, 'name'), 'revision' => HostedInput::text($item['commit'], 'id'),
                'protected' => is_bool($item['protected'] ?? null) ? $item['protected'] : null];
        }
        return ['branches' => $branches, 'page' => $page, 'next_page' => count($data) === 100 ? $page + 1 : null];
    }

    public function review(int $number): array
    {
        HostedInput::number($number);
        return $this->normalize($this->api->request('GET', [...$this->path, 'merge_requests', (string) $number]));
    }

    public function requestReview(string $branch, string $target, string $title, string $body): array
    {
        HostedInput::review($branch, $target, $title, $body);
        $existing = $this->api->request('GET', [...$this->path, 'merge_requests'], ['state' => 'opened',
            'source_branch' => $branch, 'target_branch' => $target, 'per_page' => 100]);
        if (!array_is_list($existing)) { throw new \RuntimeException('HOSTED_INVALID_RESPONSE'); }
        foreach ($existing as $item) {
            if (!is_array($item)) { throw new \RuntimeException('HOSTED_INVALID_RESPONSE'); }
            if (($item['source_branch'] ?? null) === $branch && ($item['target_branch'] ?? null) === $target
                && is_int($item['source_project_id'] ?? null) && $item['source_project_id'] === ($item['target_project_id'] ?? null)) {
                return $this->normalize($item) + ['created' => false];
            }
        }
        $data = $this->api->request('POST', [...$this->path, 'merge_requests'], [], ['source_branch' => $branch,
            'target_branch' => $target, 'title' => preg_match('/^Draft:/i', $title) ? $title : 'Draft: ' . $title,
            'description' => $body, 'remove_source_branch' => false, 'allow_collaboration' => false]);
        return $this->normalize($data) + ['created' => true];
    }

    /** @param array<mixed> $data
     * @return array<string, mixed> */
    private function normalize(array $data): array
    {
        if (!is_int($data['iid'] ?? null)) { throw new \RuntimeException('HOSTED_INVALID_RESPONSE'); }
        return ['provider' => 'gitlab', 'number' => $data['iid'], 'url' => HostedInput::link($data['web_url'] ?? null, $this->host),
            'title' => HostedInput::text($data, 'title'), 'state' => HostedInput::text($data, 'state'),
            'draft' => is_bool($data['draft'] ?? null) ? $data['draft'] : null,
            'source_branch' => HostedInput::text($data, 'source_branch'), 'target_branch' => HostedInput::text($data, 'target_branch'),
            'source_revision' => is_string($data['sha'] ?? null) ? $data['sha'] : null,
            'target_revision' => null,
            'comparison_base_revision' => is_string($data['diff_refs']['base_sha'] ?? null) ? $data['diff_refs']['base_sha'] : null,
            'merged' => ($data['state'] ?? null) === 'merged', 'clinical_approval' => false];
    }
}
