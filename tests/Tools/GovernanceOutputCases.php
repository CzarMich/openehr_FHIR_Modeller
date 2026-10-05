<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Tools;

use OpenEHR\Assistant\Application\ModelGovernance;
use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Auth\Principal;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Governance\Actor;
use OpenEHR\Assistant\Domain\Governance\ReviewPolicy;
use OpenEHR\Assistant\Domain\Modelling\QualityPipeline;
use OpenEHR\Assistant\Integrations\Governance\PreflightValidation;
use OpenEHR\Assistant\Integrations\Governance\SqliteAuditStore;
use OpenEHR\Assistant\Integrations\Repository\FileSystemRepository;
use OpenEHR\Assistant\Tests\Enterprise\TerminologyBindingPlanTest;
use OpenEHR\Assistant\Tools\GovernanceTools;
use OpenEHR\Assistant\Validation\ModelValidator;

trait GovernanceOutputCases
{
    private function governanceTools(bool $changes = false): array
    {
        $repository = new FileSystemRepository(sys_get_temp_dir() . '/governance-schema-' . bin2hex(random_bytes(8)));
        $repository->createProject('test', 'Synthetic', ''); $source = $repository->saveArtifact('test', 'templates/test.oet', TerminologyBindingPlanTest::MODEL, [], null);
        $settings = new Settings(['MODEL_REPOSITORY_WRITE_ENABLED' => 'true']); $store = new SqliteAuditStore(':memory:');
        $policy = new ReviewPolicy(); $validator = new PreflightValidation(new QualityPipeline(new ModelValidator()));
        $service = new ModelGovernance($repository, $store, $policy, $validator, new AccessPolicy($settings), new Actor('agent', 'shared', ['modeller']));
        $view = $service->prepare('test', 'templates/test.oet', $source['revision'], 'Synthetic draft');
        if ($changes) {
            $view = $service->transition($view['subject'], $view['sequence'], 'REVIEW_REQUESTED', 'Synthetic review');
            $human = new Actor('reviewer', 'shared', ['reviewer'], true, 'interactive_oidc');
            $identity = new Principal('reviewer', 'shared', ['reviewer'], ['governance.write'], true, 'interactive_oidc');
            $review = new ModelGovernance($repository, $store, $policy, $validator, new AccessPolicy($settings, $identity), $human);
            $view = $review->transition($view['subject'], $view['sequence'], 'CHANGES_REQUESTED', 'Synthetic changes');
        }
        return [new GovernanceTools($service), $source['revision'], $view];
    }
    public function test_governance_prepare_result_matches_output_schema(): void { [$tool, $revision] = $this->governanceTools(); $this->assertConforms($tool, 'prepare', ['test', 'templates/test.oet', $revision, 'Synthetic preparation']); }
    public function test_governance_validate_result_matches_output_schema(): void { [$tool, , $view] = $this->governanceTools(); $this->assertConforms($tool, 'validate', [$view['subject'], $view['sequence']]); }
    public function test_governance_request_review_result_matches_output_schema(): void { [$tool, , $view] = $this->governanceTools(); $this->assertConforms($tool, 'requestReview', [$view['subject'], $view['sequence'], 'Synthetic review']); }
    public function test_governance_reopen_draft_result_matches_output_schema(): void { [$tool, , $view] = $this->governanceTools(true); $this->assertConforms($tool, 'reopenDraft', [$view['subject'], $view['sequence'], 'Synthetic revision']); }
    public function test_governance_get_result_matches_output_schema(): void { [$tool, , $view] = $this->governanceTools(); $this->assertConforms($tool, 'get', [$view['subject']]); }
    public function test_governance_list_result_matches_output_schema(): void { [$tool] = $this->governanceTools(); $this->assertConforms($tool, 'list', ['test']); }
}
