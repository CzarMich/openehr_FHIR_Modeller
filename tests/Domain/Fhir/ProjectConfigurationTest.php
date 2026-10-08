<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Domain\Fhir;

use OpenEHR\Assistant\Domain\Fhir\ProjectConfiguration;
use OpenEHR\Assistant\Tests\Application\FhirModellingTest;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\TestCase;

#[CoversClass(ProjectConfiguration::class)]
final class ProjectConfigurationTest extends TestCase
{
    public function testAdditionalExactReleaseAndPinnedSourceAreAccepted(): void
    {
        $config = FhirModellingTest::config(); $config['fhirVersion'] = '6.0.0-snapshot1';
        $config['dependencies'] = [['id' => 'test.future', 'version' => '1.0.0', 'url' => 'https://example.org/package.tgz', 'sha256' => str_repeat('a', 64)]];
        self::assertSame('6.0.0-snapshot1', ProjectConfiguration::validate($config)['fhirVersion']);
        unset($config['dependencies'][0]['sha256']);
        $this->expectExceptionMessage('FHIR_PINNED_SOURCE_REQUIRED'); ProjectConfiguration::validate($config);
    }

    public function testCrossReleaseDependencyFails(): void
    {
        $config = FhirModellingTest::config();
        $config['dependencies'] = [['id' => 'hl7.fhir.r5.core', 'version' => '5.0.0']];
        $this->expectExceptionMessage('FHIR_DEPENDENCY_RELEASE_MISMATCH');
        ProjectConfiguration::validate($config);
    }
    public function testFloatingVersionFails(): void
    {
        $config = FhirModellingTest::config(); $config['dependencies'] = [['id' => 'example.test', 'version' => 'latest']];
        $this->expectExceptionMessage('FHIR_EXACT_DEPENDENCY_REQUIRED'); ProjectConfiguration::validate($config);
    }
    public function testNestedSecretsFail(): void
    {
        $config = FhirModellingTest::config(); $config['repository'] = ['authorization' => 'secret'];
        $this->expectExceptionMessage('FHIR_SECRET_IN_ARTIFACT_FORBIDDEN'); ProjectConfiguration::validate($config);
    }
    public function testUrlCredentialsFail(): void
    {
        $this->expectExceptionMessage('FHIR_URL_INVALID'); ProjectConfiguration::url('https://user:secret@example.org/');
    }
    public function testCallerCannotDisableReviewOrReuse(): void
    {
        $config = FhirModellingTest::config(); $config['policy'] = ['publication' => 'automatic', 'reuseFirst' => false];
        $result = ProjectConfiguration::validate($config);
        self::assertTrue($result['policy']['reuseFirst']); self::assertSame('manual-review-required', $result['policy']['publication']);
    }
}
