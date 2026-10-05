<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Validation;

use DOMDocument;
use DOMElement;

/** Element-position locators are unambiguous only within their recorded source revision. */
final class XmlLocations
{
    /** @return array<string, DOMElement> */
    public static function index(DOMDocument $document): array
    {
        $result = [];
        $walk = static function (DOMElement $element, string $location) use (&$walk, &$result): void {
            $result[$location] = $element; $index = 0;
            foreach ($element->childNodes as $child) {
                if ($child instanceof DOMElement) { $walk($child, $location . '/' . ++$index); }
            }
        };
        if ($document->documentElement !== null) { $walk($document->documentElement, '/1'); }
        return $result;
    }
}
