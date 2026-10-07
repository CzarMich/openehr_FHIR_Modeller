<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use OpenEHR\Assistant\Domain\Modelling\ArchetypeSource;
use OpenEHR\Assistant\Domain\Modelling\OpenEhrEngine;
use OpenEHR\Assistant\Domain\Modelling\TemplateAuthoringService;
use OpenEHR\Assistant\Validation\ModelValidator;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class TemplateAuthoringTest extends TestCase
{
    public const array ARCHETYPES = [
        'composition' => ['id' => 'openEHR-EHR-COMPOSITION.fixture.v1', 'rm_class' => 'COMPOSITION'],
        'section' => ['id' => 'openEHR-EHR-SECTION.fixture.v1', 'rm_class' => 'SECTION'],
        'evaluation' => ['id' => 'openEHR-EHR-EVALUATION.fixture.v1', 'rm_class' => 'EVALUATION'],
        'cluster' => ['id' => 'openEHR-EHR-CLUSTER.fixture.v1', 'rm_class' => 'CLUSTER'],
        'observation' => ['id' => 'openEHR-EHR-OBSERVATION.fixture.v1', 'rm_class' => 'OBSERVATION'],
    ];

    private function source(): ArchetypeSource
    {
        return new class implements ArchetypeSource {
            public function fetch(string $identifier, ?string $source = null): array
            {
                foreach (TemplateAuthoringTest::ARCHETYPES as $key => $archetype) {
                    if ($identifier === $key || $identifier === $archetype['id']) {
                        $content = 'fixture ADL source ' . $archetype['id'];
                        return $archetype + ['content' => $content, 'provenance' => ['kind' => 'fixture', 'ckm' => 'fixture', 'sha256' => hash('sha256', $content)]];
                    }
                }
                throw new \RuntimeException('ARCHETYPE_NOT_FOUND');
            }
        };
    }

    private function placements(): array
    {
        return [
            ['id' => 'section', 'parent' => 'root', 'identifier' => 'section', 'path' => '/content[at0001]', 'min' => '0', 'max' => '1', 'name' => 'Section'],
            ['id' => 'evaluation', 'parent' => 'section', 'identifier' => 'evaluation', 'path' => '/items[at0001]'],
            ['id' => 'cluster', 'parent' => 'evaluation', 'identifier' => 'cluster', 'path' => '/data[at0001]/items[at0002]'],
        ];
    }

    public function test_supplied_repository_sources_override_ckm_and_reach_native_compilation(): void
    {
        $root = self::ARCHETYPES['composition']['id'];
        $entry = self::ARCHETYPES['evaluation']['id'];
        $sources = array_map(static fn (string $id): array => ['identifier' => $id, 'content' => "archetype (adl_version=1.4;\n  uid=fixture)\n" . $id . "\n-- designer corrected source\n"], [$root, $entry]);
        $ckm = $this->createMock(ArchetypeSource::class);
        $ckm->expects(self::never())->method('fetch');
        $engine = $this->createMock(OpenEhrEngine::class);
        $engine->expects(self::once())->method('compile')->with(self::isString(), self::callback(static fn (array $dependencies): bool => array_column($dependencies, 'content') === array_column($sources, 'content')))->willReturn(['valid' => true]);
        $service = new TemplateAuthoringService($ckm, new ModelValidator(), $engine);
        $result = $service->generateOet('Designer sources', $root, [$entry], archetypes: $sources);
        self::assertSame('PASS', $result['native_compile_check']['status']);
        self::assertSame('supplied_source', $result['provenance'][$root]['kind']);
        self::assertFalse($result['clinical_approval']);
    }

    public function test_mismatching_source_identifiers_are_rejected_before_fetch_or_compilation(): void
    {
        $ckm = $this->createMock(ArchetypeSource::class);
        $ckm->expects(self::never())->method('fetch');
        $service = new TemplateAuthoringService($ckm, new ModelValidator());
        $this->expectException(\InvalidArgumentException::class);
        $service->generateOet('Mismatch', 'composition', ['evaluation'], archetypes: [
            ['identifier' => self::ARCHETYPES['composition']['id'], 'content' => "archetype\n" . self::ARCHETYPES['evaluation']['id'] . "\n"],
        ]);
    }

    public function test_explicit_nested_placements_preserve_parent_paths_and_compile_check_exact_sources(): void
    {
        $engine = $this->createMock(OpenEhrEngine::class);
        $engine->expects(self::once())->method('compile')->with(self::callback(static fn (string $xml): bool => str_contains($xml, 'SECTION.fixture.v1')),
            self::callback(static function (array $dependencies): bool {
                self::assertCount(4, $dependencies);
                self::assertSame(array_map(static fn (array $dependency): string => hash('sha256', $dependency['content']), $dependencies),
                    array_column($dependencies, 'sha256'));
                return true;
            }))->willReturn(['valid' => true, 'profile' => 'OET14_COMPILATION_RM_STRUCTURE', 'checks' => ['oet_application' => 'PASS'],
                'findings' => [], 'limitations' => ['bounded'], 'clinical_approval' => false]);
        $service = new TemplateAuthoringService($this->source(), new ModelValidator(), $engine);
        $result = $service->generateOet('Nested fixture', 'composition', [], 'fixture', $this->placements());

        self::assertSame('DRAFT', $result['status']);
        self::assertFalse($result['clinical_approval']);
        self::assertSame('PASS', $result['native_compile_check']['status']);
        self::assertSame(4, count($result['provenance']));
        self::assertCount(4, $result['dependencies']);
        foreach ($result['dependencies'] as $dependency) {
            self::assertSame('fixture ADL source ' . $dependency['identifier'], $dependency['content']);
            self::assertSame($result['provenance'][$dependency['identifier']]['sha256'], $dependency['sha256']);
        }
        $document = ModelValidator::xml($result['content']);
        $xpath = new \DOMXPath($document);
        $xpath->registerNamespace('oet', 'openEHR/v1/Template');
        self::assertSame(1, $xpath->query('/oet:template/oet:definition/oet:Content[@path="/content[at0001]"]/oet:Item[@path="/items[at0001]"]/oet:Items[@path="/data[at0001]/items[at0002]"]')->length);
        self::assertSame('0', $xpath->query('/oet:template/oet:definition/oet:Content/@min')->item(0)?->nodeValue);
    }

    public function test_nested_placements_without_engine_are_reported_unexecuted_and_invalid_parent_order_fails(): void
    {
        $service = new TemplateAuthoringService($this->source(), new ModelValidator());
        $result = $service->generateOet('Nested fixture', 'composition', [], placements: $this->placements());
        self::assertSame('NOT_EXECUTED', $result['native_compile_check']['status']);
        self::assertFalse($result['clinical_approval']);

        $invalid = $this->placements();
        $invalid[1]['parent'] = 'later';
        try {
            $service->generateOet('Nested fixture', 'composition', [], placements: $invalid);
            self::fail('Forward parent reference was accepted.');
        } catch (\InvalidArgumentException $error) {
            self::assertStringContainsString('Parents must precede children', $error->getMessage());
        }
    }

    public function test_direct_entry_drafts_are_checked_against_exact_root_and_entry_sources_when_engine_exists(): void
    {
        $engine = $this->createMock(OpenEhrEngine::class);
        $engine->expects(self::once())->method('compile')->with(self::isString(), self::callback(static function (array $dependencies): bool {
            self::assertCount(2, $dependencies);
            foreach ($dependencies as $dependency) {
                self::assertSame(hash('sha256', $dependency['content']), $dependency['sha256']);
            }
            return true;
        }))->willReturn(['valid' => true, 'profile' => 'OET14_COMPILATION_RM_STRUCTURE', 'checks' => [], 'findings' => [], 'limitations' => [], 'clinical_approval' => false]);
        $service = new TemplateAuthoringService($this->source(), new ModelValidator(), $engine);
        $result = $service->generateOet('Direct fixture', 'composition', ['evaluation']);
        self::assertSame('PASS', $result['native_compile_check']['status']);
        self::assertSame('direct_entries_only', $result['placements']);
        self::assertSame(['openEHR-EHR-COMPOSITION.fixture.v1', 'openEHR-EHR-EVALUATION.fixture.v1'], array_column($result['dependencies'], 'identifier'));
        self::assertFalse($result['clinical_approval']);
    }

    public function test_nested_placement_rejects_rm_incompatible_child_and_duplicate_paths(): void
    {
        $service = new TemplateAuthoringService($this->source(), new ModelValidator());
        $placements = $this->placements();
        $placements[1]['identifier'] = 'cluster';
        try {
            $service->generateOet('Nested fixture', 'composition', [], placements: $placements);
            self::fail('A CLUSTER was accepted as a direct SECTION item.');
        } catch (\InvalidArgumentException $error) {
            self::assertSame('The child RM class is not a supported placement for its parent.', $error->getMessage());
        }

        $placements = $this->placements();
        $placements[1]['identifier'] = 'evaluation';
        $placements[1]['path'] = $placements[0]['path'];
        $placements[1]['parent'] = 'root';
        try {
            $service->generateOet('Nested fixture', 'composition', [], placements: $placements);
            self::fail('Repeated sibling path accepted.');
        } catch (\InvalidArgumentException $error) {
            self::assertSame('Duplicate sibling placement path.', $error->getMessage());
        }
    }
}
