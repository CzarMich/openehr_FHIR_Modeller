<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Tools;

use OpenEHR\Assistant\Application\RepositoryService;
use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Repository\HostedGitRepository;
use OpenEHR\Assistant\Domain\Repository\HostedRepositoryProvider;
use OpenEHR\Assistant\Tools\RepositoryTools;

trait HostedOutputCases
{
    private function repositoryTools(): RepositoryTools
    {
        $hosting = $this->createStub(HostedRepositoryProvider::class);
        $hosting->method('metadata')->willReturn(['provider' => 'github', 'repository' => 'fixture/models']);
        $hosting->method('branches')->willReturn(['branches' => [['name' => 'main', 'protected' => true]], 'next_page' => null]);
        $review = ['number' => 1, 'draft' => true, 'clinical_approval' => false];
        $hosting->method('requestReview')->willReturn($review);
        $hosting->method('review')->willReturn($review);
        $repository = $this->createStub(HostedGitRepository::class);
        $repository->method('hosting')->willReturn($hosting);
        $repository->method('capabilities')->willReturn(['reviews' => true]);
        $repository->method('createBranch')->willReturn(str_repeat('a', 40));
        $repository->method('diff')->willReturn(['patch' => '+synthetic model']);
        $settings = new Settings(['MODEL_REPOSITORY_WRITE_ENABLED' => 'true']);
        return new RepositoryTools(new RepositoryService($repository, new AccessPolicy($settings), $settings));
    }

    public function test_model_repository_info_result_matches_output_schema(): void { $this->assertConforms($this->repositoryTools(), 'info', []); }
    public function test_model_repository_branches_result_matches_output_schema(): void { $this->assertConforms($this->repositoryTools(), 'branches', []); }
    public function test_model_branch_create_result_matches_output_schema(): void { $this->assertConforms($this->repositoryTools(), 'createBranch', ['draft/model', str_repeat('a', 40)]); }
    public function test_model_review_request_result_matches_output_schema(): void { $this->assertConforms($this->repositoryTools(), 'requestReview', ['draft/model', 'Review']); }
    public function test_model_review_get_result_matches_output_schema(): void { $this->assertConforms($this->repositoryTools(), 'review', [1]); }
    public function test_model_repository_diff_result_matches_output_schema(): void { $this->assertConforms($this->repositoryTools(), 'diff', [str_repeat('a', 40), str_repeat('b', 40)]); }
}
