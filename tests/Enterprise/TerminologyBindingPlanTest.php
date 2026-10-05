<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use OpenEHR\Assistant\Application\TerminologyBindingPlans;
use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Repository\ModelRepository;
use OpenEHR\Assistant\Domain\Terminology\BindingPlanner;
use OpenEHR\Assistant\Domain\Terminology\BindingService;
use OpenEHR\Assistant\Domain\Terminology\Catalogue\LocalOperations;
use OpenEHR\Assistant\Domain\Terminology\Catalogue\Resource;
use OpenEHR\Assistant\Domain\Terminology\ValueSet;
use OpenEHR\Assistant\Integrations\Auth\ConfiguredAccessToken;
use OpenEHR\Assistant\Integrations\Repository\FileSystemRepository;
use OpenEHR\Assistant\Integrations\Repository\GitModelRepository;
use OpenEHR\Assistant\Integrations\Repository\SharePoint\GraphClient;
use OpenEHR\Assistant\Integrations\Repository\SharePointRepository;
use OpenEHR\Assistant\Integrations\Terminology\FhirTerminologyProvider;
use OpenEHR\Assistant\Integrations\Terminology\XmlTerminologyInspector;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class TerminologyBindingPlanTest extends TestCase
{
    private array $directories = [];
    public const string MODEL = '<template xmlns="openEHR/v1/Template" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><definition archetype_id="openEHR-EHR-OBSERVATION.feeding.v1"><Rule path="/data/items[at0001]"><constraint xsi:type="textConstraint" limitToList="true"><includedValues>https://example.org/local/feeding::mixed</includedValues></constraint></Rule></definition></template>';
    public const array ALIASES = [['terminology_id' => TerminologyCatalogueTest::SYSTEM, 'system' => TerminologyCatalogueTest::SYSTEM, 'version' => 'cs-7']];

    public static function providers(): array { return [['filesystem'], ['git'], ['sharepoint']]; }

    private function repository(string $provider = 'filesystem'): ModelRepository
    {
        $path = sys_get_temp_dir() . '/binding-plan-' . bin2hex(random_bytes(8)); $this->directories[] = $path;
        if ($provider === 'sharepoint') {
            $settings = new Settings(['MODEL_REPOSITORY_PROVIDER' => 'sharepoint', 'SHAREPOINT_SITE_ID' => 'site', 'SHAREPOINT_LIST_ID' => 'list',
                'SHAREPOINT_DRIVE_ID' => 'drive', 'SHAREPOINT_FOLDER_ID' => 'folder', 'SHAREPOINT_ACCESS_TOKEN' => 'fixture-token']);
            $repository = new SharePointRepository($settings, new GraphClient($settings, new ConfiguredAccessToken('fixture-token'), (new SharePointGraphFixture())->client()));
        } elseif ($provider === 'git') { $repository = new GitModelRepository(new Settings(['MODEL_REPOSITORY_PROVIDER' => 'git', 'MODEL_REPOSITORY_PATH' => $path])); }
        else { $repository = new FileSystemRepository($path); }
        $repository->createProject('project', 'Synthetic project', '');
        $repository->saveArtifact('project', 'templates/template.oet', self::MODEL, [], null);
        foreach ([TerminologyCatalogueTest::codeSystem(), TerminologyCatalogueTest::valueSet()] as $data) { $this->record($repository, $data); }
        return $repository;
    }

    private function record(ModelRepository $repository, array $data, ?string $revision = null): array
    {
        $resource = new Resource($data);
        return $repository->saveArtifact('project', $resource->path(), json_encode($resource->data, JSON_THROW_ON_ERROR), [], $revision);
    }

    public static function service(ModelRepository $repository, bool $writes = true): TerminologyBindingPlans
    {
        return new TerminologyBindingPlans($repository, new AccessPolicy(new Settings(['MODEL_REPOSITORY_WRITE_ENABLED' => $writes ? 'true' : 'false'])),
            new XmlTerminologyInspector(), new BindingPlanner(new LocalOperations()));
    }

    protected function tearDown(): void
    {
        foreach ($this->directories as $directory) {
            if (!is_dir($directory)) { continue; }
            $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($directory, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
            foreach ($iterator as $file) { $file->isDir() && !$file->isLink() ? rmdir($file->getPathname()) : unlink($file->getPathname()); }
            rmdir($directory);
        }
    }

    #[DataProvider('providers')]
    public function test_contract_preserves_source_and_records_versions_history_conflicts_and_staleness(string $provider): void
    {
        $repository = $this->repository($provider); $service = self::service($repository); $model = $repository->getArtifact('project', 'templates/template.oet');
        $plan = $service->plan('project', 'templates/template.oet', null, self::ALIASES); $decision = $plan['analysis']['decisions'][0];
        self::assertCount(1, $decision['candidates']); self::assertTrue($decision['candidates'][0]['code_system_versions_confirmed']);
        self::assertSame('vs-3', $decision['candidates'][0]['value_set']['version']);
        self::assertTrue($decision['code_validation'][0]['valid']); self::assertFalse($plan['analysis']['release_ready']);
        self::assertFalse($plan['analysis']['model_changed']); self::assertFalse($plan['analysis']['clinical_approval']);
        $saved = $service->save('project', 'templates/template.oet', $model['revision'], self::ALIASES);
        self::assertSame('DRAFT', $saved['artifact']['status']);
        self::assertSame('CURRENT', $service->get('project', 'templates/template.oet')['freshness']['status']);
        try { $service->save('project', 'templates/template.oet', $model['revision']); self::fail('Overwrite must require expected revision'); }
        catch (\RuntimeException $error) { self::assertStringContainsString('CONFLICT', $error->getMessage()); }
        $this->record($repository, TerminologyCatalogueTest::valueSet(['version' => 'vs-4']));
        $stale = $service->get('project', 'templates/template.oet'); self::assertSame('STALE_OR_MODIFIED', $stale['freshness']['status']);
        self::assertTrue($stale['freshness']['source_matches']); self::assertFalse($stale['freshness']['catalogue_matches']);
        $next = $service->save('project', 'templates/template.oet', $model['revision'], self::ALIASES, $saved['artifact']['revision']);
        self::assertCount(2, $next['plan']['analysis']['decisions'][0]['candidates']);
        self::assertContains('AMBIGUOUS_VALUE_SET_CANDIDATES', array_column($next['plan']['analysis']['findings'], 'code'));
        self::assertSame($saved['artifact']['revision'], $service->get('project', 'templates/template.oet', $saved['artifact']['revision'])['artifact']['revision']);
        self::assertSame($model, $repository->getArtifact('project', 'templates/template.oet'));
        $repository->saveArtifact('project', 'templates/template.oet', str_replace('mixed', 'old', self::MODEL), [], $model['revision']);
        self::assertFalse($service->get('project', 'templates/template.oet')['freshness']['source_matches']);
        $this->expectExceptionMessage('MODEL_REVISION_CONFLICT'); $service->save('project', 'templates/template.oet', $model['revision'], [], $next['artifact']['revision']);
    }

    public function test_unpinned_editions_are_never_inferred_from_one_catalogue_match(): void
    {
        $plan = self::service($this->repository())->plan('project', 'templates/template.oet'); $decision = $plan['analysis']['decisions'][0];
        self::assertFalse($decision['candidates'][0]['code_system_versions_confirmed']);
        self::assertSame('NOT_EXECUTED', $decision['code_validation'][0]['status']);
        self::assertNull($decision['resolved_codings'][0]['version']);
    }

    public function test_incompatible_member_edition_cannot_supply_a_binding_candidate(): void
    {
        $aliases = self::ALIASES; $aliases[0]['version'] = 'cs-8';
        $plan = self::service($this->repository())->plan('project', 'templates/template.oet', null, $aliases);
        self::assertSame([], $plan['analysis']['decisions'][0]['candidates']);
        self::assertSame('NOT_EXECUTED', $plan['analysis']['decisions'][0]['code_validation'][0]['status']);
    }

    public function test_inactive_code_system_member_remains_an_error_even_if_a_draft_value_set_lists_it(): void
    {
        $repository = $this->repository(); $model = $repository->getArtifact('project', 'templates/template.oet');
        $repository->saveArtifact('project', 'templates/template.oet', str_replace('::mixed', '::old', self::MODEL), [], $model['revision']);
        $set = new Resource(TerminologyCatalogueTest::valueSet()); $old = $repository->getArtifact('project', $set->path());
        $this->record($repository, TerminologyCatalogueTest::valueSet(['concepts' => [
            ['system' => TerminologyCatalogueTest::SYSTEM, 'version' => 'cs-7', 'code' => 'old', 'display' => 'Outdated choice']]]), $old['revision']);
        $plan = self::service($repository)->plan('project', 'templates/template.oet', null, self::ALIASES);
        self::assertFalse($plan['analysis']['decisions'][0]['code_validation'][0]['valid']);
        $errors = array_values(array_filter($plan['analysis']['findings'], static fn (array $finding): bool => $finding['severity'] === 'error'));
        self::assertSame('CODE_INVALID_IN_SELECTED_EDITION', $errors[0]['code']); self::assertFalse($plan['analysis']['release_ready']);
    }

    public function test_external_reference_supplies_no_invented_local_membership(): void
    {
        $repository = $this->repository(); $set = new Resource(TerminologyCatalogueTest::valueSet());
        $old = $repository->getArtifact('project', $set->path());
        $this->record($repository, TerminologyCatalogueTest::valueSet(['source' => 'external', 'concepts' => []]), $old['revision']);
        $plan = self::service($repository)->plan('project', 'templates/template.oet', null, self::ALIASES);
        self::assertSame([], $plan['analysis']['decisions'][0]['candidates']);
        self::assertSame('NOT_EXECUTED', $plan['analysis']['external_discovery']);
    }

    public function test_deleted_source_does_not_make_saved_evidence_current(): void
    {
        $repository = $this->repository(); $service = self::service($repository); $model = $repository->getArtifact('project', 'templates/template.oet');
        $service->save('project', 'templates/template.oet', $model['revision']);
        $repository->deleteArtifact('project', 'templates/template.oet', $model['revision']);
        $read = $service->get('project', 'templates/template.oet');
        self::assertSame('NOT_EXECUTED', $read['freshness']['status']); self::assertNull($read['freshness']['matches_current_analysis']);
    }

    public function test_existing_named_query_is_opaque_and_preserved_even_when_it_looks_like_a_canonical(): void
    {
        $repository = $this->repository(); $old = $repository->getArtifact('project', 'templates/template.oet');
        $model = str_replace('<includedValues>', '<termQueryId terminologyID="server-query" terminologyLang="en" queryName="https://example.org/sets/admission-feeding"/><includedValues>', self::MODEL);
        $repository->saveArtifact('project', 'templates/template.oet', $model, [], $old['revision']);
        $plan = self::service($repository)->plan('project', 'templates/template.oet'); $decision = $plan['analysis']['decisions'][0];
        self::assertSame('PRESERVE_EXISTING', $decision['action']); self::assertSame([], $decision['candidates']);
        self::assertNull($decision['existing_references'][0]['canonical']); self::assertSame('oet_named_query', $decision['existing_references'][0]['kind']);
        self::assertSame($model, $repository->getArtifact('project', 'templates/template.oet')['content']);
    }

    public function test_opt_canonical_and_native_binding_blocks_are_preserved_without_assuming_an_edition(): void
    {
        $xml = '<template xmlns="http://schemas.openehr.org/v1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><definition><children xsi:type="C_CODE_REFERENCE"><terminology_id><value>https://example.org/local/feeding</value></terminology_id><code_list>mixed</code_list><referenceSetUri>https://example.org/sets/admission-feeding</referenceSetUri></children><term_bindings terminology="urn:oid:1.2.3"><items code="at0001"><value>original</value></items></term_bindings></definition></template>';
        $inspection = (new XmlTerminologyInspector())->inspect($xml, 'opt');
        self::assertSame(TerminologyCatalogueTest::SET, $inspection['slots'][0]['existing_references'][0]['canonical']);
        self::assertNull($inspection['slots'][0]['existing_references'][0]['version']);
        self::assertSame('urn:oid:1.2.3', $inspection['existing_bindings'][0]['terminology']); self::assertSame(hash('sha256', $xml), $inspection['content_sha256']);
        self::assertFalse($inspection['slots'][0]['native_semantics_verified']);
    }

    public function test_free_text_and_local_identifiers_are_not_turned_into_external_codes(): void
    {
        foreach (['Mixed feeding', 'local::at0001', 'SNOMED-CT::123', 'urn:test:ambiguous::123::456'] as $value) {
            $xml = str_replace('https://example.org/local/feeding::mixed', $value, self::MODEL);
            $inspection = (new XmlTerminologyInspector())->inspect($xml, 'oet');
            $plan = (new BindingPlanner(new LocalOperations()))->plan($inspection, []);
            self::assertSame([], $plan['decisions'][0]['resolved_codings']); self::assertSame(1, $plan['decisions'][0]['unresolved_count']);
            self::assertContains('UNRESOLVED_TERMINOLOGY_LITERAL', array_column($plan['findings'], 'code'));
        }
    }

    public function test_scoped_alias_does_not_leak_to_another_archetype(): void
    {
        $xml = str_replace('https://example.org/local/feeding', 'local', self::MODEL);
        $inspection = (new XmlTerminologyInspector())->inspect($xml, 'oet'); $planner = new BindingPlanner(new LocalOperations());
        $alias = ['terminology_id' => 'local', 'system' => 'urn:local:feeding', 'archetype' => 'different'];
        self::assertSame([], $planner->plan($inspection, [], [$alias])['decisions'][0]['resolved_codings']);
        $alias['archetype'] = 'openEHR-EHR-OBSERVATION.feeding.v1';
        self::assertSame('urn:local:feeding', $planner->plan($inspection, [], [$alias])['decisions'][0]['resolved_codings'][0]['system']);
    }

    public static function invalidAliases(): array
    {
        return [[['terminology_id' => 'local', 'system' => 'urn:local:x']], [['terminology_id' => 'https://one.example', 'system' => 'https://another.example']],
            [['terminology_id' => 'x', 'system' => 'javascript:alert(1)']], [['terminology_id' => 'x', 'system' => 'urn:test:x', 'approved' => true]]];
    }
    #[DataProvider('invalidAliases')]
    public function test_invalid_or_unscoped_aliases_fail_closed(array $alias): void
    {
        $this->expectException(\InvalidArgumentException::class); (new BindingPlanner(new LocalOperations()))->aliases([$alias]);
    }

    public function test_wrong_namespace_types_and_unsupported_adl_are_not_interpreted_as_valid_models(): void
    {
        $xml = str_replace('xmlns:xsi=', 'xmlns:foreign="urn:foreign" xmlns:xsi=', self::MODEL);
        $xml = str_replace('xsi:type="textConstraint"', 'xsi:type="foreign:textConstraint"', $xml);
        self::assertSame([], (new XmlTerminologyInspector())->inspect($xml, 'oet')['slots']);
        self::assertSame('NOT_EXECUTED', (new XmlTerminologyInspector())->inspect('archetype...', 'adl')['status']);
        $this->expectExceptionMessage('UNSUPPORTED_TERMINOLOGY_XML_PROFILE'); (new XmlTerminologyInspector())->inspect(self::MODEL, 'opt');
    }

    public function test_xml_external_entities_are_rejected(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        (new XmlTerminologyInspector())->inspect('<!DOCTYPE template [<!ENTITY leak SYSTEM "file:///etc/passwd">]>' . self::MODEL, 'oet');
    }

    public function test_large_inspection_is_rejected_without_truncating_coverage(): void
    {
        $xml = str_replace('<includedValues>https://example.org/local/feeding::mixed</includedValues>', str_repeat('<includedValues>urn:test:x::x</includedValues>', 101), self::MODEL);
        $this->expectExceptionMessage('TERMINOLOGY_INSPECTION_LIMIT_EXCEEDED'); (new XmlTerminologyInspector())->inspect($xml, 'oet');
    }

    public function test_invalid_catalogue_records_remain_findings_and_prevent_complete_coverage(): void
    {
        $repository = $this->repository(); $repository->saveArtifact('project', 'terminology/catalogue/invalid.json', '{}', [], null);
        $plan = self::service($repository)->plan('project', 'templates/template.oet');
        self::assertFalse($plan['analysis']['catalogue_complete']); self::assertContains('INVALID_TERMINOLOGY_RECORD', array_column($plan['analysis']['findings'], 'code'));
    }

    public function test_plan_changes_are_detected_and_writes_enforce_access_policy(): void
    {
        $repository = $this->repository(); $service = self::service($repository); $model = $repository->getArtifact('project', 'templates/template.oet');
        $saved = $service->save('project', 'templates/template.oet', $model['revision']); $plan = $saved['plan']; $plan['analysis']['clinical_approval'] = true;
        $repository->saveArtifact('project', $saved['artifact']['path'], json_encode($plan, JSON_THROW_ON_ERROR), [], $saved['artifact']['revision']);
        $read = $service->get('project', 'templates/template.oet'); self::assertSame('STALE_OR_MODIFIED', $read['freshness']['status']); self::assertFalse($read['clinical_approval']);
        $this->expectExceptionMessage('WRITES_DISABLED'); self::service($repository, false)->save('project', 'templates/template.oet', $model['revision']);
    }

    public function test_binding_target_rejects_ambiguous_relative_paths_and_accepts_exact_location(): void
    {
        $service = new BindingService(new FhirTerminologyProvider(new Settings()));
        $set = new ValueSet('set', 'https://example.org/system', '1', [['code' => 'x', 'display' => 'X']]);
        $binding = ['id' => 'binding', 'artifact' => 'test.oet', 'node' => '/items[at1]', 'strength' => 'REQUIRED', 'value_set' => 'set', 'value_set_version' => '1', 'codes' => ['x']];
        $model = '<template><a path="/items[at1]"/><b path="/items[at1]"/></template>';
        $ambiguous = $service->validate($binding, $set, $model); self::assertFalse($ambiguous['valid']); self::assertContains('BINDING_TARGET_AMBIGUOUS', $ambiguous['errors']);
        $binding['target_location'] = '/1/2'; $exact = $service->validate($binding, $set, $model);
        self::assertSame([], $exact['errors']); self::assertSame(['/1/2'], $exact['target_locations']);
        $binding['target_location'] = '/1/3'; self::assertContains('BINDING_TARGET_NOT_EXPLICIT_IN_TEMPLATE', $service->validate($binding, $set, $model)['errors']);
        $binding['target_location'] = '/1/*'; $this->expectException(\InvalidArgumentException::class); $service->validate($binding, $set, $model);
    }
}
