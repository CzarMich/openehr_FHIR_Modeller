<?php
declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Resources;

use OpenEHR\Assistant\Resources\Terminologies;
use Mcp\Exception\ResourceReadException;
use Mcp\Server;
use Mcp\Server\Builder;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\TestCase;

#[CoversClass(Terminologies::class)]
final class TerminologiesTest extends TestCase
{
    private Terminologies $terminologies;

    protected function setUp(): void
    {
        $this->terminologies = new Terminologies();
    }

    public function test_read_all(): void
    {
        $result = $this->terminologies->readAll();

        $this->assertIsArray($result);
        $this->assertArrayHasKey('codesets', $result);
        $this->assertArrayHasKey('groups', $result);

        // Check if codeset is an array of codesets
        $this->assertIsArray($result['codesets']);
        $this->assertGreaterThan(1, count($result['codesets']));

        // Check first codeset
        $firstCodeset = $result['codesets'][0];
        $this->assertEquals('compression_algorithms', $firstCodeset['openehr_id']);
        $this->assertArrayHasKey('codeset', $firstCodeset);

        // Check if group is an array of groups
        $this->assertIsArray($result['groups']);
        $this->assertGreaterThan(1, count($result['groups']));

        // Check first group
        $firstGroup = $result['groups'][0];
        $this->assertEquals('attestation_reason', $firstGroup['openehr_id']);
        $this->assertArrayHasKey('group', $firstGroup);
    }
}
