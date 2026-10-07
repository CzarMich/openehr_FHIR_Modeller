<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Terminology\Catalogue;

/** Versioned platform terminology record. Its schema is independent of FHIR serialization. */
final readonly class Resource
{
    /** @var array<string, mixed> */
    public array $data;
    public const array KINDS = ['code_system', 'value_set', 'concept_map'];

    /** @param array<string, mixed> $data */
    public function __construct(array $data)
    {
        self::keys($data, ['kind', 'canonical', 'version', 'name', 'description', 'language', 'source', 'provenance',
            'case_sensitive', 'content', 'concepts', 'mappings', 'dependencies']);
        if (!in_array($data['kind'] ?? null, self::KINDS, true)) { throw new \InvalidArgumentException('INVALID_TERMINOLOGY_KIND'); }
        self::canonical($data['canonical'] ?? null);
        self::text($data['version'] ?? null, 200); self::text($data['name'] ?? null, 200);
        foreach (['description' => 10000, 'language' => 100] as $field => $length) {
            if (isset($data[$field])) { self::text($data[$field], $length); }
        }
        $data['source'] ??= 'local';
        if (!in_array($data['source'], ['local', 'external'], true)) { throw new \InvalidArgumentException('INVALID_TERMINOLOGY_SOURCE'); }
        $provenance = $data['provenance'] ?? null;
        if (!is_array($provenance)) { throw new \InvalidArgumentException('TERMINOLOGY_PROVENANCE_REQUIRED'); }
        self::keys($provenance, ['source', 'licence', 'author', 'retrieved_at', 'source_revision']);
        self::text($provenance['source'] ?? null, 2048);
        foreach ($provenance as $value) { self::text($value, 2048); }
        $dependencies = self::items($data['dependencies'] ?? [], 500);
        $seen = [];
        foreach ($dependencies as $dependency) {
            self::keys($dependency, ['kind', 'canonical', 'version']);
            if (!in_array($dependency['kind'] ?? null, self::KINDS, true)) { throw new \InvalidArgumentException('INVALID_TERMINOLOGY_DEPENDENCY'); }
            self::canonical($dependency['canonical'] ?? null); self::text($dependency['version'] ?? null, 200);
            $key = self::identity($dependency['kind'], $dependency['canonical'], $dependency['version']);
            if (isset($seen[$key])) { throw new \InvalidArgumentException('DUPLICATE_TERMINOLOGY_DEPENDENCY'); }
            $seen[$key] = true;
        }
        $data['dependencies'] = $dependencies;
        if ($data['kind'] === 'concept_map') {
            foreach (['concepts', 'case_sensitive', 'content'] as $key) {
                if (array_key_exists($key, $data)) { throw new \InvalidArgumentException('INVALID_CONCEPT_MAP_FIELD'); }
            }
            $data['mappings'] = self::mappings($data['mappings'] ?? []);
        } else {
            if (array_key_exists('mappings', $data)) { throw new \InvalidArgumentException('INVALID_TERMINOLOGY_FIELD'); }
            if ($data['kind'] === 'value_set' && (isset($data['case_sensitive']) || isset($data['content']))) {
                throw new \InvalidArgumentException('VALUE_SET_CANNOT_DEFINE_CODE_SYSTEM_SEMANTICS');
            }
            if ($data['kind'] === 'code_system' && $data['source'] === 'external' && (isset($data['case_sensitive']) || isset($data['content']))) {
                throw new \InvalidArgumentException('EXTERNAL_REFERENCE_CANNOT_ASSERT_LOCAL_SEMANTICS');
            }
            if ($data['kind'] === 'code_system' && $data['source'] === 'local') {
                $data['case_sensitive'] ??= true; $data['content'] ??= 'complete';
                if (!is_bool($data['case_sensitive']) || !in_array($data['content'], ['complete', 'fragment'], true)) {
                    throw new \InvalidArgumentException('INVALID_CODE_SYSTEM_SEMANTICS');
                }
            }
            $data['concepts'] = self::concepts($data['concepts'] ?? [], $data['kind'], $data['case_sensitive'] ?? true);
            if ($data['kind'] === 'code_system') { self::hierarchy($data['concepts'], $data['case_sensitive'] ?? true); }
        }
        if ($data['source'] === 'external' && (($data['concepts'] ?? []) !== [] || ($data['mappings'] ?? []) !== [])) {
            throw new \InvalidArgumentException('EXTERNAL_REFERENCE_CANNOT_ASSERT_LOCAL_CONTENT');
        }
        try { $encoded = json_encode($data, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE, 32); }
        catch (\JsonException) { throw new \InvalidArgumentException('INVALID_TERMINOLOGY_RECORD'); }
        if (strlen($encoded) > 1048576) { throw new \InvalidArgumentException('TERMINOLOGY_RECORD_TOO_LARGE'); }
        $this->data = $data;
    }

    public function path(): string
    {
        return 'terminology/catalogue/' . $this->data['kind'] . '/' . self::identity($this->data['kind'], $this->data['canonical'], $this->data['version']) . '.json';
    }

    /** Decode a repository record and verify its logical identity.
     * @param array<string, mixed> $artifact */
    public static function fromArtifact(array $artifact): self
    {
        if (!is_string($artifact['content'] ?? null) || strlen($artifact['content']) > 2097152) { throw new \InvalidArgumentException('INVALID_TERMINOLOGY_RECORD'); }
        $data = json_decode($artifact['content'], true, 32, JSON_THROW_ON_ERROR);
        if (!is_array($data)) { throw new \InvalidArgumentException('INVALID_TERMINOLOGY_RECORD'); }
        $resource = new self($data);
        if ($resource->path() !== $artifact['path']) { throw new \InvalidArgumentException('CATALOGUE_IDENTITY_MISMATCH'); }
        return $resource;
    }

    public static function identity(string $kind, string $canonical, string $version): string
    {
        return hash('sha256', json_encode([$kind, $canonical, $version], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    }

    public static function canonical(mixed $value): void
    {
        self::text($value, 2048);
        if (preg_match('/[\s|#]/u', $value)) { throw new \InvalidArgumentException('INVALID_TERMINOLOGY_CANONICAL'); }
        if (preg_match('/^urn:[A-Za-z0-9][A-Za-z0-9-]{0,31}:.+$/D', $value)) { return; }
        $parts = parse_url($value);
        if ($parts === false || !in_array($parts['scheme'] ?? '', ['http', 'https'], true) || empty($parts['host'])
            || isset($parts['user']) || isset($parts['pass'])) { throw new \InvalidArgumentException('INVALID_TERMINOLOGY_CANONICAL'); }
    }

    public static function text(mixed $value, int $max): void
    {
        if (!is_string($value) || $value === '' || strlen($value) > $max || preg_match('//u', $value) !== 1
            || preg_match('/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/', $value)) { throw new \InvalidArgumentException('INVALID_TERMINOLOGY_TEXT'); }
    }

    /** @param array<string, mixed> $data
     * @param list<string> $allowed */
    public static function keys(array $data, array $allowed): void
    {
        if (array_diff(array_keys($data), $allowed) !== []) { throw new \InvalidArgumentException('UNKNOWN_TERMINOLOGY_FIELD'); }
    }

    /** @return list<array<string, mixed>> */
    private static function items(mixed $items, int $max): array
    {
        if (!is_array($items) || !array_is_list($items) || count($items) > $max) { throw new \InvalidArgumentException('INVALID_TERMINOLOGY_LIST'); }
        foreach ($items as $item) {
            if (!is_array($item) || array_is_list($item)) { throw new \InvalidArgumentException('INVALID_TERMINOLOGY_ITEM'); }
        }
        return $items;
    }

    /** @return array<string, mixed> */
    public static function coding(mixed $coding): array
    {
        if (!is_array($coding)) { throw new \InvalidArgumentException('INVALID_TERMINOLOGY_CODING'); }
        self::keys($coding, ['system', 'version', 'code', 'display']);
        self::canonical($coding['system'] ?? null); self::text($coding['code'] ?? null, 500);
        if (isset($coding['version'])) { self::text($coding['version'], 200); }
        if (isset($coding['display'])) { self::text($coding['display'], 2000); }
        return $coding;
    }

    public static function codeKey(string $code, bool $sensitive): string { return $sensitive ? $code : mb_convert_case($code, MB_CASE_FOLD, 'UTF-8'); }

    /** @return list<array<string, mixed>> */
    private static function concepts(mixed $input, string $kind, bool $sensitive): array
    {
        $items = self::items($input, 5000); $seen = [];
        foreach ($items as $item) {
            self::keys($item, $kind === 'code_system' ? ['code', 'display', 'definition', 'inactive', 'abstract', 'designation', 'parents']
                : ['system', 'version', 'code', 'display', 'inactive', 'abstract', 'designation']);
            self::text($item['code'] ?? null, 500); self::text($item['display'] ?? null, 2000);
            if (isset($item['definition'])) { self::text($item['definition'], 10000); }
            foreach (['inactive', 'abstract'] as $flag) {
                if (isset($item[$flag]) && !is_bool($item[$flag])) { throw new \InvalidArgumentException('INVALID_CONCEPT_STATUS'); }
            }
            foreach (self::items($item['designation'] ?? [], 100) as $designation) {
                self::keys($designation, ['language', 'value', 'use']); self::text($designation['language'] ?? null, 100);
                self::text($designation['value'] ?? null, 2000);
                if (isset($designation['use'])) { self::coding($designation['use']); }
            }
            if ($kind === 'value_set') {
                self::canonical($item['system'] ?? null);
                if (isset($item['version'])) { self::text($item['version'], 200); }
                $key = json_encode([$item['system'], $item['version'] ?? null, $item['code']], JSON_THROW_ON_ERROR);
            } else { $key = self::codeKey($item['code'], $sensitive); }
            if (isset($seen[$key])) { throw new \InvalidArgumentException('DUPLICATE_TERMINOLOGY_CODE'); }
            $seen[$key] = true;
        }
        return $items;
    }

    /** Validate a bounded DAG without recursive traversal.
     * @param list<array<string, mixed>> $concepts */
    private static function hierarchy(array $concepts, bool $sensitive): void
    {
        $incoming = []; $edges = [];
        foreach ($concepts as $concept) { $incoming[self::codeKey($concept['code'], $sensitive)] = 0; }
        foreach ($concepts as $concept) {
            $code = self::codeKey($concept['code'], $sensitive); $parents = $concept['parents'] ?? [];
            if (!is_array($parents) || !array_is_list($parents) || count($parents) > 50) { throw new \InvalidArgumentException('INVALID_CONCEPT_PARENTS'); }
            $seen = [];
            foreach ($parents as $parent) {
                self::text($parent, 500); $parent = self::codeKey($parent, $sensitive);
                if (!array_key_exists($parent, $incoming) || isset($seen[$parent])) { throw new \InvalidArgumentException('UNRESOLVED_OR_DUPLICATE_CONCEPT_PARENT'); }
                $seen[$parent] = true; $incoming[$code]++; $edges[$parent][] = $code;
            }
        }
        $queue = array_keys(array_filter($incoming, static fn (int $n): bool => $n === 0)); $visited = 0;
        for ($i = 0; $i < count($queue); $i++) {
            $visited++;
            foreach ($edges[$queue[$i]] ?? [] as $child) { if (--$incoming[$child] === 0) { $queue[] = $child; } }
        }
        if ($visited !== count($concepts)) { throw new \InvalidArgumentException('CYCLIC_TERMINOLOGY_HIERARCHY'); }
    }

    /** @return list<array<string, mixed>> */
    private static function mappings(mixed $input): array
    {
        $items = self::items($input, 5000); $seen = [];
        foreach ($items as $item) {
            self::keys($item, ['source', 'target', 'relationship', 'comment', 'conditions']);
            self::coding($item['source'] ?? null);
            $relation = $item['relationship'] ?? null;
            if (!in_array($relation, ['equivalent', 'related', 'broader', 'narrower', 'inexact', 'unmatched', 'disjoint'], true)) {
                throw new \InvalidArgumentException('INVALID_MAPPING_RELATIONSHIP');
            }
            if ($relation !== 'unmatched' || isset($item['target'])) { self::coding($item['target'] ?? null); }
            if (isset($item['comment'])) { self::text($item['comment'], 10000); }
            foreach (self::items($item['conditions'] ?? [], 100) as $condition) {
                self::keys($condition, ['property', 'value']); self::text($condition['property'] ?? null, 500); self::text($condition['value'] ?? null, 2000);
            }
            $key = json_encode([$item['source'], $item['target'] ?? null, $relation, $item['conditions'] ?? []], JSON_THROW_ON_ERROR);
            if (isset($seen[$key])) { throw new \InvalidArgumentException('DUPLICATE_MAPPING'); }
            $seen[$key] = true;
        }
        return $items;
    }
}
