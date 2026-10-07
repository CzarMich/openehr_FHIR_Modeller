<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Engine;

use GuzzleHttp\Client;
use OpenEHR\Assistant\Configuration\EngineConfiguration;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Modelling\OpenEhrEngine;
use OpenEHR\Assistant\Validation\JsonDocument;

final readonly class HttpOpenEhrEngine implements OpenEhrEngine
{
    private Client $client;
    private const int LIMIT = 16777216;

    public function __construct(private Settings $settings, ?Client $client = null)
    {
        $this->client = $client ?? new Client([
            'timeout' => (int) $settings->get('OPENEHR_ENGINE_TIMEOUT'), 'connect_timeout' => 3,
            'allow_redirects' => false, 'cookies' => false, 'http_errors' => false, 'proxy' => '',
            'verify' => $settings->get('HTTP_CA_BUNDLE') ?: true,
            'on_headers' => static function (\Psr\Http\Message\ResponseInterface $response): void {
                if ((int) $response->getHeaderLine('Content-Length') > self::LIMIT) {
                    throw new \RuntimeException('ENGINE_OUTPUT_LIMIT');
                }
            },
            'progress' => static function (float $total, float $downloaded): void {
                if ($total > self::LIMIT || $downloaded > self::LIMIT) {
                    throw new \RuntimeException('ENGINE_OUTPUT_LIMIT');
                }
            },
        ]);
    }

    public function validate(string $content, string $format, array $dependencies = []): array
    {
        $operation = match ($format) {
            'adl2' => 'validate/archetype', 'adlt2' => 'validate/template',
            'opt2', 'opt14' => 'validate/opt', 'aql' => 'validate/aql',
            default => throw new \InvalidArgumentException('ENGINE_FORMAT_UNSUPPORTED'),
        };
        return $this->request($operation, $content, $dependencies);
    }

    public function compile(string $content, array $dependencies): array
    {
        return $this->request('compile/template', $content, $dependencies);
    }

    public function inspect(string $content, string $format, array $dependencies = []): array
    {
        $operation = match ($format) {
            'adl2' => 'inspect/archetype', 'opt2', 'opt14' => 'inspect/opt',
            default => throw new \InvalidArgumentException('ENGINE_FORMAT_UNSUPPORTED'),
        };
        if (($format === 'opt14') !== self::legacyXml($content)) {
            throw new \InvalidArgumentException('ENGINE_FORMAT_MISMATCH');
        }
        return $this->request($operation, $content, $dependencies);
    }

    /** @param list<array{identifier: string, content: string, sha256: string}> $dependencies
     * @return array<string, mixed> */
    private function request(string $operation, string $content, array $dependencies): array
    {
        $legacy = self::legacyXml($content) && (str_ends_with($operation, '/template') || str_ends_with($operation, '/opt'));
        if ($this->settings->get('OPENEHR_ENGINE_URL') === '') {
            throw new \RuntimeException('ENGINE_NOT_CONFIGURED');
        }
        $body = json_encode(['content' => $content, 'dependencies' => $dependencies], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
        if (strlen($body) > 8388608) {
            throw new \InvalidArgumentException('ENGINE_INPUT_LIMIT');
        }
        $key = EngineConfiguration::key($this->settings);
        try {
            $response = $this->client->post($this->settings->get('OPENEHR_ENGINE_URL') . '/v1/' . $operation, [
                'headers' => ['X-Engine-Key' => $key, 'Content-Type' => 'application/json', 'Accept' => 'application/json'],
                'body' => $body, 'allow_redirects' => false, 'cookies' => false, 'http_errors' => false,
            ]);
        } catch (\Throwable) {
            throw new \RuntimeException('ENGINE_UNAVAILABLE');
        }
        if ($response->getStatusCode() !== 200) {
            throw new \RuntimeException(match ($response->getStatusCode()) {
                401, 403 => 'ENGINE_AUTHENTICATION_FAILED', 413 => 'ENGINE_INPUT_LIMIT',
                503 => 'ENGINE_BUSY', 504 => 'ENGINE_TIMEOUT', default => 'ENGINE_RESPONSE_REJECTED',
            });
        }
        $payload = $response->getBody()->read(self::LIMIT + 1);
        if (strlen($payload) > self::LIMIT || !str_starts_with(strtolower($response->getHeaderLine('Content-Type')), 'application/json')) {
            throw new \RuntimeException('ENGINE_RESPONSE_INVALID');
        }
        try {
            JsonDocument::parse($payload, self::LIMIT, 1000000);
            $decoded = json_decode($payload, true, 64, JSON_THROW_ON_ERROR);
        } catch (\Throwable) {
            throw new \RuntimeException('ENGINE_RESPONSE_INVALID');
        }
        if (!is_array($decoded) || !is_bool($decoded['ok'] ?? null)) {
            throw new \RuntimeException('ENGINE_RESPONSE_INVALID');
        }
        if (!$decoded['ok']) {
            $code = is_array($decoded['error'] ?? null) ? ($decoded['error']['code'] ?? null) : null;
            throw new \RuntimeException(is_string($code) && preg_match('/^ENGINE_[A-Z0-9_]{1,70}$/D', $code) ? $code : 'ENGINE_RESPONSE_INVALID');
        }
        $data = $decoded['data'] ?? null;
        $aqlTemplates = $operation === 'validate/aql' && $dependencies !== []
            && is_array($data) && ($data['completed_stage'] ?? null) === 'template_paths';
        if (!is_array($data) || ($data['schema_version'] ?? null) !== 1 || ($data['operation'] ?? null) !== $operation
            || ($data['content_sha256'] ?? null) !== hash('sha256', $content) || !is_bool($data['valid'] ?? null)
            || (!($aqlTemplates && !$data['valid'] && ($data['status'] ?? null) === 'INCOMPLETE')
                && ($data['status'] ?? null) !== ($data['valid'] ? 'PASS' : 'FAIL')) || ($data['clinical_approval'] ?? null) !== false
            || !is_array($data['engine'] ?? null) || !is_array($data['findings'] ?? null)) {
            throw new \RuntimeException('ENGINE_RESPONSE_INVALID');
        }
        if (isset($data['output'])) {
            $output = $data['output'];
            if (!is_array($output) || !is_string($output['content'] ?? null) || ($output['format'] ?? null) !== ($legacy ? 'opt14_xml' : 'opt2_adl')
                || ($output['sha256'] ?? null) !== hash('sha256', $output['content'])) {
                throw new \RuntimeException('ENGINE_OUTPUT_HASH_MISMATCH');
            }
        }
        if (isset($data['web_template'])) {
            $web = $data['web_template'];
            if (!is_array($web) || !is_string($web['content'] ?? null) || ($web['format'] ?? null) !== 'web_template_json'
                || ($web['sha256'] ?? null) !== hash('sha256', $web['content']) || ($data['checks']['web_template_generation'] ?? null) !== 'PASS') {
                throw new \RuntimeException('ENGINE_OUTPUT_HASH_MISMATCH');
            }
        }
        if (!array_is_list($data['findings']) || count($data['findings']) > 1000) {
            throw new \RuntimeException('ENGINE_RESPONSE_INVALID');
        }
        foreach ($data['findings'] as $finding) {
            if (!is_array($finding) || !in_array($finding['severity'] ?? null, ['error', 'warning'], true)
                || !is_string($finding['code'] ?? null) || !is_string($finding['message'] ?? null)
                || !is_string($finding['location'] ?? null) || !is_array($finding['evidence'] ?? null)
                || !is_string($finding['remediation'] ?? null) || ($data['valid'] && $finding['severity'] === 'error')) {
                throw new \RuntimeException('ENGINE_RESPONSE_INVALID');
            }
        }
        foreach (['adapter', 'archie', 'aql'] as $version) {
            if (!is_string($data['engine'][$version] ?? null) || !preg_match('/^[0-9]+\.[0-9]+\.[0-9]+$/D', $data['engine'][$version])) {
                throw new \RuntimeException('ENGINE_RESPONSE_INVALID');
            }
        }
        $profile = $operation === 'validate/aql' ? 'AQL_SYNTAX' : (str_ends_with($operation, '/opt') ? 'OPT2_FLAT_AOM_BMM' : 'ADL2_AOM2_BMM');
        if ($aqlTemplates) {
            $profile = 'AQL_TEMPLATE_PATHS';
            if (($data['checks']['aql_syntax'] ?? null) !== 'PASS'
                || ($data['checks']['model_paths'] ?? null) !== $data['status']
                || ($data['checks']['query_execution'] ?? null) !== 'NOT_EXECUTED'
                || !is_array($data['templates'] ?? null) || !array_is_list($data['templates'])
                || count($data['templates']) !== count($dependencies)) {
                throw new \RuntimeException('ENGINE_RESPONSE_INVALID');
            }
            $expectedTemplates = array_column($dependencies, 'sha256', 'identifier');
            foreach ($data['templates'] as $template) {
                if (!is_array($template) || !is_string($template['identifier'] ?? null)
                    || !isset($expectedTemplates[$template['identifier']])
                    || ($template['sha256'] ?? null) !== $expectedTemplates[$template['identifier']]
                    || !in_array($template['status'] ?? null, ['PASS', 'FAIL', 'INCOMPLETE'], true)
                    || !is_array($template['paths'] ?? null)
                    || ($data['valid'] && $template['status'] !== 'PASS')) {
                    throw new \RuntimeException('ENGINE_RESPONSE_INVALID');
                }
                unset($expectedTemplates[$template['identifier']]);
            }
        } elseif ($operation === 'validate/aql' && $dependencies !== [] && $data['valid']) {
            throw new \RuntimeException('ENGINE_RESPONSE_INVALID');
        }
        if ($legacy) {
            $profile = str_ends_with($operation, '/opt') ? 'OPT14_XML_RM_STRUCTURE' : 'OET14_COMPILATION_RM_STRUCTURE';
            if (($data['checks']['full_aom_semantics'] ?? null) !== 'NOT_EXECUTED'
                || ($data['checks']['clinical_review'] ?? null) !== 'NOT_EXECUTED'
                || ($data['rm_release_basis'] ?? null) !== 'explicit_legacy_compatibility_profile'
                || !is_array($data['limitations'] ?? null)) {
                throw new \RuntimeException('ENGINE_RESPONSE_INVALID');
            }
        }
        if (($data['profile'] ?? null) !== $profile || !is_string($data['completed_stage'] ?? null)) {
            throw new \RuntimeException('ENGINE_RESPONSE_INVALID');
        }
        if (($data['valid'] && $operation !== 'validate/aql') || $aqlTemplates) {
            $manifest = $data['dependencies'] ?? null;
            if (!is_array($manifest) || !array_is_list($manifest) || count($manifest) !== count($dependencies)) {
                throw new \RuntimeException('ENGINE_DEPENDENCY_MANIFEST_INVALID');
            }
            $expected = array_column($dependencies, 'sha256', 'identifier');
            foreach ($manifest as $item) {
                if (!is_array($item) || !is_string($item['identifier'] ?? null) || !isset($expected[$item['identifier']])
                    || ($item['sha256'] ?? null) !== $expected[$item['identifier']]) {
                    throw new \RuntimeException('ENGINE_DEPENDENCY_MANIFEST_INVALID');
                }
                unset($expected[$item['identifier']]);
            }
        }
        if ($operation === 'compile/template' && $data['valid'] && !isset($data['output'])) {
            throw new \RuntimeException('ENGINE_OUTPUT_MISSING');
        }
        return $data;
    }

    private static function legacyXml(string $content): bool
    {
        return str_starts_with(ltrim(str_starts_with($content, "\xEF\xBB\xBF") ? substr($content, 3) : $content), '<');
    }
}
