<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Modelling;

use OpenEHR\Assistant\Validation\ModelValidator;

final readonly class QualityPipeline
{
    public function __construct(private ModelValidator $validator)
    {
    }

    /**
     * @return array<string, mixed> */
    public function run(string $content, string $format): array
    {
        $validation = $this->validator->validate($content, $format);
        $steps = [['name' => 'model_preflight', 'status' => $validation['status'], 'report' => $validation]];
        $findings = $validation['findings'];
        foreach ($validation['stages'] as $stage) {
            $steps[] = $stage;
            if ($stage['status'] === 'NOT_EXECUTED') {
                $findings[] = self::unexecuted($stage['name'], $stage['reason']);
            }
        }
        foreach (['archetype_dependency_validation', 'ckm_version_validation', 'terminology_binding_validation',
            'value_set_validation', 'terminology_version_check', 'opt_compilation', 'opt_validation',
            'test_compositions', 'aql_execution', 'requirements_coverage'] as $step) {
            $reason = 'No applicable verified input or executor supplied to this document-only pipeline.';
            $steps[] = ['name' => $step, 'status' => 'NOT_EXECUTED', 'reason' => $reason];
            $findings[] = self::unexecuted($step, $reason);
        }
        return ['status' => $validation['valid'] === false ? 'FAIL' : 'INCOMPLETE', 'release_eligible' => false,
            'content_sha256' => hash('sha256', $content), 'steps' => $steps, 'findings' => $findings,
            'scope' => 'Deterministic document profiles; repository and qualified engine checks remain separate.',
            'executed_at' => gmdate(DATE_ATOM)];
    }

    /** @return array<string, mixed> */
    private static function unexecuted(string $check, string $reason): array
    {
        return ['severity' => 'warning', 'code' => 'CHECK_NOT_EXECUTED', 'location' => '/', 'message' => $reason,
            'evidence' => ['check' => $check], 'remediation' => 'Supply the required verified context and executor before relying on this check for release.'];
    }
}
