<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use OpenEHR\Assistant\Application\TerminologyCatalogue;
use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Auth\Principal;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Repository\ModelRepository;
use OpenEHR\Assistant\Domain\Terminology\Catalogue\LocalOperations;
use OpenEHR\Assistant\Domain\Terminology\Catalogue\Resource;
use OpenEHR\Assistant\Domain\Terminology\MappingProvider;
use OpenEHR\Assistant\Domain\Terminology\TerminologyProvider;
use OpenEHR\Assistant\Integrations\Auth\ConfiguredAccessToken;
use OpenEHR\Assistant\Integrations\Repository\FileSystemRepository;
use OpenEHR\Assistant\Integrations\Repository\GitModelRepository;
use OpenEHR\Assistant\Integrations\Repository\SharePoint\GraphClient;
use OpenEHR\Assistant\Integrations\Repository\SharePointRepository;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class TerminologyCatalogueTest extends TestCase
{
    public const string SYSTEM = 'https://example.org/local/feeding';
    public const string SET = 'https://example.org/sets/admission-feeding';
    public const string MAP = 'https://example.org/maps/feeding';
    private array $directories = [];

    public static function codeSystem(array $replace = []): array
    {
        return array_replace(['kind' => 'code_system', 'canonical' => self::SYSTEM, 'version' => 'cs-7', 'name' => 'Feeding',
            'provenance' => ['source' => 'Synthetic fixture'], 'language' => 'en', 'concepts' => [
                ['code' => 'feeding', 'display' => 'Feeding category', 'abstract' => true],
                ['code' => 'mixed', 'display' => 'Mixed feeding', 'parents' => ['feeding'], 'designation' => [['language' => 'de', 'value' => 'Gemischte Ernährung']]],
                ['code' => 'old', 'display' => 'Old option', 'inactive' => true]]], $replace);
    }

    public static function valueSet(array $replace = []): array
    {
        return array_replace(['kind' => 'value_set', 'canonical' => self::SET, 'version' => 'vs-3', 'name' => 'Admission feeding',
            'provenance' => ['source' => 'Synthetic fixture'], 'concepts' => [
                ['system' => self::SYSTEM, 'version' => 'cs-7', 'code' => 'mixed', 'display' => 'Mixed feeding'],
                ['system' => 'urn:oid:1.2.3', 'version' => '2', 'code' => 'mixed', 'display' => 'Separate coding']]], $replace);
    }

    public static function conceptMap(array $replace = []): array
    {
        return array_replace(['kind' => 'concept_map', 'canonical' => self::MAP, 'version' => 'map-2', 'name' => 'Feeding mapping',
            'provenance' => ['source' => 'Synthetic fixture'], 'mappings' => [
                ['source' => ['system' => self::SYSTEM, 'version' => 'cs-7', 'code' => 'mixed'], 'target' => ['system' => 'urn:oid:1.2.3', 'code' => 'm'], 'relationship' => 'equivalent'],
                ['source' => ['system' => self::SYSTEM, 'code' => 'mixed'], 'target' => ['system' => 'urn:oid:1.2.3', 'code' => 'n'], 'relationship' => 'broader', 'conditions' => [['property' => 'context', 'value' => 'review explicitly']]],
                ['source' => ['system' => self::SYSTEM, 'code' => 'unknown'], 'relationship' => 'unmatched']]], $replace);
    }

    public static function providers(): array { return [['filesystem'], ['git'], ['sharepoint']]; }

    private function repository(string $provider = 'filesystem'): ModelRepository
    {
        $path = sys_get_temp_dir() . '/catalogue-' . bin2hex(random_bytes(8)); $this->directories[] = $path;
        if ($provider === 'sharepoint') {
            $settings = new Settings(['MODEL_REPOSITORY_PROVIDER' => 'sharepoint', 'SHAREPOINT_SITE_ID' => 'site', 'SHAREPOINT_LIST_ID' => 'list',
                'SHAREPOINT_DRIVE_ID' => 'drive', 'SHAREPOINT_FOLDER_ID' => 'folder', 'SHAREPOINT_ACCESS_TOKEN' => 'fixture-token']);
            $repository = new SharePointRepository($settings, new GraphClient($settings, new ConfiguredAccessToken('fixture-token'), (new SharePointGraphFixture())->client()));
        } elseif ($provider === 'git') { $repository = new GitModelRepository(new Settings(['MODEL_REPOSITORY_PROVIDER' => 'git', 'MODEL_REPOSITORY_PATH' => $path])); }
        else { $repository = new FileSystemRepository($path); }
        $repository->createProject('project', 'Synthetic project', '');
        return $repository;
    }

    private function catalogue(?ModelRepository $repository = null, ?AccessPolicy $policy = null, ?TerminologyProvider $external = null): TerminologyCatalogue
    {
        if ($external === null) {
            $external = $this->createMock(TerminologyProvider::class);
            foreach (['lookup', 'validateCode', 'expand'] as $method) { $external->expects(self::never())->method($method); }
        }
        $maps = $this->createMock(MappingProvider::class); $maps->expects(self::never())->method('translate');
        return new TerminologyCatalogue($repository ?? $this->repository(), $policy ?? new AccessPolicy(new Settings(['MODEL_REPOSITORY_WRITE_ENABLED' => 'true'])), $external, $maps, new LocalOperations());
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
    public function test_catalogue_contract_keeps_revision_history_conflicts_and_offline_operations(string $provider): void
    {
        $repository = $this->repository($provider); $catalogue = $this->catalogue($repository);
        $first = $catalogue->save('project', self::codeSystem());
        $set = $catalogue->save('project', self::valueSet()); $catalogue->save('project', self::conceptMap());
        self::assertSame('DRAFT', $first['status']); self::assertFalse($first['clinical_approval']);
        self::assertTrue($catalogue->lookup('project', self::SYSTEM, 'mixed')['valid']);
        self::assertFalse($catalogue->lookup('project', self::SYSTEM, 'invented')['valid']);
        self::assertFalse($catalogue->lookup('project', self::SYSTEM, 'feeding')['valid']);
        self::assertFalse($catalogue->lookup('project', self::SYSTEM, 'old')['valid']);
        self::assertTrue($catalogue->validate('project', self::SYSTEM, 'mixed', self::SET, 'vs-3', 'cs-7')['valid']);
        self::assertSame($set['revision'], $catalogue->expand('project', self::SET)['catalogue_evidence']['revision']);
        $translated = $catalogue->translate('project', self::MAP, self::SYSTEM, 'mixed', 'map-2', 'cs-7');
        self::assertCount(2, $translated['candidates']); self::assertFalse($translated['applied']);
        self::assertTrue($translated['candidates'][0]['source_version_confirmed']); self::assertFalse($translated['candidates'][1]['conditions_verified']);
        $next = $catalogue->save('project', self::codeSystem(['description' => 'Clarified description']), $first['revision']);
        self::assertArrayNotHasKey('description', $catalogue->get('project', 'code_system', self::SYSTEM, 'cs-7', $first['revision'])['resource']);
        self::assertSame($next['revision'], $catalogue->get('project', 'code_system', self::SYSTEM)['revision']);
        self::assertCount(2, $repository->history('project', $first['path']));
        try { $catalogue->save('project', self::codeSystem(), $first['revision']); self::fail('Stale write accepted'); }
        catch (\RuntimeException $error) { self::assertSame('REVISION_CONFLICT', $error->getMessage()); }
    }

    public function test_missing_version_never_silently_selects_a_newer_edition(): void
    {
        $catalogue = $this->catalogue(); $catalogue->save('project', self::codeSystem()); $catalogue->save('project', self::codeSystem(['version' => 'cs-8']));
        self::assertSame('cs-7', $catalogue->lookup('project', self::SYSTEM, 'mixed', 'cs-7')['version']);
        $this->expectExceptionMessage('AMBIGUOUS_TERMINOLOGY_VERSION'); $catalogue->lookup('project', self::SYSTEM, 'mixed');
    }

    public function test_local_fragment_cannot_reject_unknown_code_as_invalid_in_the_complete_system(): void
    {
        $local = new LocalOperations(); $fragment = new Resource(self::codeSystem(['content' => 'fragment']));
        self::assertTrue($local->lookup($fragment, 'mixed')['valid']);
        $unknown = $local->lookup($fragment, 'new'); self::assertSame('NOT_EXECUTED', $unknown['status']); self::assertNull($unknown['valid']);
    }

    public function test_language_and_case_rules_are_explicit_and_unicode_aware(): void
    {
        $local = new LocalOperations(); $resource = new Resource(self::codeSystem(['case_sensitive' => false]));
        self::assertSame('Gemischte Ernährung', $local->lookup($resource, 'MIXED', 'de')['concept']['display']);
        self::assertTrue($local->validate($resource, self::SYSTEM, 'MIXED', 'cs-7', 'Gemischte Ernährung', 'de')['valid']);
        self::assertSame('NOT_EXECUTED', $local->validate($resource, self::SYSTEM, 'mixed', 'cs-7', 'Mixed feeding', 'fr')['status']);
        self::assertFalse($local->validate($resource, self::SYSTEM, 'mixed', 'cs-7', 'Incorrect display', 'en')['valid']);
        $unicode = new Resource(self::codeSystem(['case_sensitive' => false, 'concepts' => [['code' => 'ÄBC', 'display' => 'Example']]]));
        self::assertTrue($local->lookup($unicode, 'äbc')['valid']);
    }

    public function test_value_set_preserves_multiple_systems_and_does_not_guess_unversioned_members(): void
    {
        $local = new LocalOperations(); $set = new Resource(self::valueSet());
        self::assertTrue($local->validate($set, self::SYSTEM, 'mixed', 'cs-7')['valid']);
        self::assertTrue($local->validate($set, 'urn:oid:1.2.3', 'mixed', '2')['valid']);
        self::assertFalse($local->validate($set, 'urn:oid:1.2.3', 'mixed', 'cs-7')['valid']);
        $record = self::valueSet(); unset($record['concepts'][0]['version']);
        self::assertSame('NOT_EXECUTED', $local->validate(new Resource($record), self::SYSTEM, 'mixed', 'cs-7')['status']);
        $record = self::valueSet(); $record['concepts'][] = array_replace($record['concepts'][0], ['version' => 'cs-8']);
        self::assertSame('NOT_EXECUTED', $local->validate(new Resource($record), self::SYSTEM, 'mixed')['status']);
    }

    public function test_expansion_and_catalogue_search_are_bounded_and_deterministic(): void
    {
        $catalogue = $this->catalogue(); $catalogue->save('project', self::valueSet()); $catalogue->save('project', self::codeSystem());
        $result = $catalogue->search('project', query: 'FEEDING', count: 1); self::assertSame(2, $result['total']); self::assertFalse($result['complete']);
        self::assertArrayNotHasKey('concepts', $result['items'][0]['resource']);
        $page = $catalogue->expand('project', self::SET, count: 1, offset: 1);
        self::assertSame('urn:oid:1.2.3', $page['items'][0]['system']); self::assertFalse($page['complete']);
        $size = $catalogue->expand('project', self::SET, count: 0); self::assertSame(2, $size['total']); self::assertSame([], $size['items']);
    }

    public function test_external_references_use_the_pinned_provider_without_local_success_fallback(): void
    {
        $external = $this->createMock(TerminologyProvider::class);
        $external->expects(self::once())->method('lookup')->with(self::SYSTEM, 'mixed', 'cs-7', null)
            ->willReturn(['status' => 'NOT_EXECUTED', 'valid' => null, 'errors' => ['TERMINOLOGY_NOT_CONFIGURED']]);
        $catalogue = $this->catalogue(external: $external); $catalogue->save('project', self::codeSystem(['source' => 'external', 'concepts' => []]));
        self::assertSame('NOT_EXECUTED', $catalogue->lookup('project', self::SYSTEM, 'mixed')['status']);
    }

    public function test_corrupt_or_misplaced_external_git_edit_remains_a_qa_finding(): void
    {
        $repository = $this->repository(); $catalogue = $this->catalogue($repository); $first = $catalogue->save('project', self::codeSystem());
        $changed = self::codeSystem(['version' => 'different']); $repository->saveArtifact('project', $first['path'], json_encode($changed), [], $first['revision']);
        $result = $catalogue->search('project'); self::assertFalse($result['complete']); self::assertCount(1, $result['findings']);
        self::assertSame('INVALID_TERMINOLOGY_RECORD', $result['findings'][0]['code']);
        $this->expectExceptionMessage('CATALOGUE_HAS_INVALID_RECORDS'); $catalogue->lookup('project', self::SYSTEM, 'mixed');
    }

    public function test_record_size_is_bounded_before_repository_write(): void
    {
        $concepts = [];
        for ($i = 0; $i < 5000; $i++) { $concepts[] = ['code' => 'code-' . $i, 'display' => str_repeat('x', 250)]; }
        $this->expectExceptionMessage('TERMINOLOGY_RECORD_TOO_LARGE');
        new Resource(self::codeSystem(['concepts' => $concepts]));
    }

    public function test_write_policy_applies_to_catalogue_mutations(): void
    {
        $policy = new AccessPolicy(new Settings(['AUTH_MODE' => 'oidc', 'MODEL_REPOSITORY_WRITE_ENABLED' => 'true',
            'OIDC_ISSUER' => 'https://identity.example/', 'OIDC_AUDIENCE' => 'modelling']), new Principal('reader', 'tenant'));
        $this->expectExceptionMessage('WRITE_PERMISSION_REQUIRED'); $this->catalogue(policy: $policy)->save('project', self::codeSystem());
    }

    #[DataProvider('invalidRecords')]
    public function test_invalid_or_approval_claiming_records_are_rejected(array $record): void
    {
        $this->expectException(\InvalidArgumentException::class); new Resource($record);
    }

    public static function invalidRecords(): array
    {
        $base = self::codeSystem(); $missing = $base; unset($missing['provenance']);
        return [[$missing], [self::codeSystem(['approved_by' => 'agent'])], [self::codeSystem(['status' => 'APPROVED'])],
            [self::codeSystem(['canonical' => 'https://user:password@example.org/cs'])], [self::codeSystem(['canonical' => 'file:///tmp/code'])],
            [self::codeSystem(['canonical' => 'https://example.org/cs|7'])], [self::codeSystem(['version' => ''])],
            [self::codeSystem(['case_sensitive' => 'false'])], [self::codeSystem(['source' => 'external'])],
            [self::codeSystem(['concepts' => [['code' => 'x', 'display' => 'X', 'parents' => ['missing']]]])],
            [self::codeSystem(['concepts' => [['code' => 'x', 'display' => 'X', 'parents' => ['x']]]])],
            [self::codeSystem(['concepts' => [['code' => 'x', 'display' => 'X', 'parents' => ['y']], ['code' => 'y', 'display' => 'Y', 'parents' => ['x']]]])],
            [self::codeSystem(['case_sensitive' => false, 'concepts' => [['code' => 'Ä', 'display' => 'X'], ['code' => 'ä', 'display' => 'Y']]])],
            [self::valueSet(['case_sensitive' => false])], [self::valueSet(['concepts' => [['code' => 'x', 'display' => 'X']]])],
            [self::conceptMap(['mappings' => [['source' => ['system' => self::SYSTEM, 'code' => 'x'], 'relationship' => 'equivalent']]])],
            [self::conceptMap(['mappings' => [['source' => ['system' => self::SYSTEM, 'code' => 'x'], 'relationship' => 'invented']]])]];
    }
}
