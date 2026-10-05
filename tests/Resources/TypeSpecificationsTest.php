<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Resources;

use OpenEHR\Assistant\Resources\TypeSpecifications;
use Mcp\Exception\ResourceReadException;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\TestCase;

#[CoversClass(TypeSpecifications::class)]
final class TypeSpecificationsTest extends TestCase
{
    public function testReadReturnsDecodedArrayForKnownType(): void
    {
        $res = (new TypeSpecifications())->read('RM', 'COMPOSITION');
        $this->assertIsArray($res);
        $this->assertSame('COMPOSITION', $res['name'] ?? null);
        $this->assertArrayHasKey('properties', $res);
        $this->assertArrayHasKey('package', $res);
    }

    public function testInvalidComponentAndNameAreRejected(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        (new TypeSpecifications())->read('RM!', 'COMPOSITION');
    }

    public function testMissingFileThrowsResourceReadException(): void
    {
        $this->expectException(ResourceReadException::class);
        (new TypeSpecifications())->read('RM', 'THIS_TYPE_DOES_NOT_EXIST');
    }
}
