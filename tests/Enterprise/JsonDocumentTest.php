<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use OpenEHR\Assistant\Validation\JsonDocument;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class JsonDocumentTest extends TestCase
{
    public function test_large_escaped_native_xml_is_scanned_without_regex_stack_exhaustion(): void
    {
        $xml = '<template>' . str_repeat('<items id="text">Unicode: ä, 😀; slash \\ and braces {"x":1}</items>', 16000) . '</template>';
        $json = json_encode(['output' => ['content' => $xml], 'after' => ['value' => true]], JSON_THROW_ON_ERROR);
        self::assertSame($xml, JsonDocument::parse($json, 16777216, 1000000)->output->content);
        self::assertTrue(JsonDocument::parse($json, 16777216, 1000000)->after->value);
        $this->expectExceptionMessage('DUPLICATE_JSON_KEY');
        JsonDocument::parse(substr($json, 0, -1) . ',"\\u0061fter": false}', 16777216, 1000000);
    }

    public function test_scanner_retains_nested_duplicate_and_token_boundaries(): void
    {
        $valid = json_encode(['a' => [['a' => 1], ['a' => 2]], 'escaped"key' => 'quoted " colon : braces {} and \\', 'unicode' => 'ä'], JSON_THROW_ON_ERROR);
        self::assertCount(2, JsonDocument::parse($valid)->a);
        foreach (['{"a":{"x":1,"\\u0078":2}}', '{"a":1,"a":2}'] as $invalid) {
            try {
                JsonDocument::parse($invalid);
                self::fail('Accepted a duplicate object key.');
            } catch (\InvalidArgumentException $error) {
                self::assertSame('DUPLICATE_JSON_KEY', $error->getMessage());
            }
        }
        $this->expectExceptionMessage('JSON_DOCUMENT_TOKEN_LIMIT');
        JsonDocument::parse('[1,2,3,4]', 100, 3);
    }
}
