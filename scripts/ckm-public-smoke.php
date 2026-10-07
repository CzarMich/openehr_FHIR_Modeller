<?php

declare(strict_types=1);

/** Opt-in read-only acceptance against two public reference CKMs; never uses deployment credentials. */
require dirname(__DIR__) . '/vendor/autoload.php';

use OpenEHR\Assistant\Apis\CkmClient;
use OpenEHR\Assistant\Application\FederatedCkmSearch;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Integrations\Knowledge\ConfiguredCkmSearch;
use Psr\Log\NullLogger;

if (!in_array('--allow-public-network', $argv, true)) {
    fwrite(STDERR, "Use --allow-public-network for read-only live reference-source acceptance.\n");
    exit(2);
}
$settings = new Settings(['CKM_SOURCES' => '{"norway":"https://arketyper.no/ckm/rest/"}', 'CKM_TIMEOUT' => '15', 'CKM_FEDERATION_TIMEOUT' => '30']);
$client = new CkmClient(new NullLogger(), null, $settings);
$provider = new ConfiguredCkmSearch($client, new NullLogger());
$result = (new FederatedCkmSearch($provider, $settings))->search('archetype', 'body weight', ['default', 'norway'], 10);
$retrievals = [];
foreach (['default', 'norway'] as $source) {
    $found = $provider->search($source, 'archetype', 'body weight', 5, 15);
    if ($found['items'] === []) {
        throw new RuntimeException('No public reference candidate was returned for the acceptance query.');
    }
    $item = $found['items'][0];
    if (!preg_match('/^[0-9]+(?:\.[0-9]+)+$/D', $item['cid'])) {
        throw new RuntimeException('The public reference source did not return a retrievable CID.');
    }
    $response = $client->forSource($source)->get('v1/archetypes/' . $item['cid'] . '/adl');
    $content = (string) $response->getBody();
    if ($response->getStatusCode() !== 200 || !str_contains($content, $item['archetypeId'])) {
        throw new RuntimeException('Retrieved source content did not contain the discovered archetype identity.');
    }
    $retrievals[] = ['source' => $source, 'cid' => $item['cid'], 'archetype_id' => $item['archetypeId'],
        'sha256' => hash('sha256', $content), 'bytes' => strlen($content)];
}
if (!$result['all_sources_responded'] || count(array_unique(array_column($result['items'], 'source'))) !== 2) {
    throw new RuntimeException('The public federated source acceptance was incomplete.');
}
echo json_encode(['timestamp' => gmdate(DATE_ATOM), 'status' => 'PASS', 'scope' => 'Read-only public CKM discovery/retrieval; no model changes or clinical certification',
    'sources' => $client->sources(), 'source_results' => $result['source_results'], 'retrievals' => $retrievals], JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";
