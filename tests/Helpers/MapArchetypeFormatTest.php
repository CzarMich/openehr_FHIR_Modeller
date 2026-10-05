<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Helpers;

use OpenEHR\Assistant\Helpers\Map;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\TestCase;

#[CoversClass(Map::class)]
final class MapArchetypeFormatTest extends TestCase
{
    public function testArchetypeFormatMappings(): void
    {
        $this->assertSame('adl', Map::archetypeFormat('adl'));
        $this->assertSame('xml', Map::archetypeFormat('xml'));
        $this->assertSame('mindmap', Map::archetypeFormat('mindmap'));
    }

    public function testArchetypeFormatThrowsOnInvalid(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        Map::archetypeFormat('invalid');
    }
}
