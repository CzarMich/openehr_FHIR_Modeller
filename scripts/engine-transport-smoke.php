<?php

declare(strict_types=1);

// Independent transport probe executed inside the application's shared network namespace.
function probe(string $method, string $path, string $body, array $headers = []): array
{
    $curl = curl_init('http://127.0.0.1:8090' . $path);
    curl_setopt_array($curl, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_POSTFIELDS => $body, CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 55, CURLOPT_FOLLOWLOCATION => false, CURLOPT_HTTPHEADER => $headers]);
    $wire = curl_exec($curl);
    if (!is_string($wire)) {
        throw new RuntimeException('Engine transport failed.');
    }
    return [curl_getinfo($curl, CURLINFO_HTTP_CODE), json_decode($wire, true, 64, JSON_THROW_ON_ERROR)];
}
function check(bool $condition, string $name): void
{
    if (!$condition) {
        throw new RuntimeException($name);
    }
    echo "PASS $name\n";
}
$key = trim(file_get_contents('/run/secrets/engine-key'));
$headers = ['Content-Type: application/json', 'X-Engine-Key: ' . $key];
$body = json_encode(['content' => 'SELECT e/ehr_id/value FROM EHR e'], JSON_THROW_ON_ERROR);
check(probe('POST', '/v1/validate/aql', $body, ['Content-Type: application/json'])[0] === 401, 'Service credential required');
check(probe('POST', '/v1/validate/aql', $body, [...$headers, 'Host: attacker.example'])[0] === 403, 'Host rebinding rejected');
check(probe('POST', '/v1/validate/aql', $body, [...$headers, 'Origin: https://attacker.example'])[0] === 403, 'Browser origin rejected');
check(probe('GET', '/v1/validate/aql', '', $headers)[0] === 405, 'Wrong method rejected');
check(probe('POST', '/v1/execute', $body, $headers)[0] === 404, 'Arbitrary operation rejected');
check(probe('POST', '/v1/validate/aql', '{"content":"SELECT 1","content":"SELECT 2"}', $headers)[0] === 400, 'Duplicate JSON rejected');
check(probe('POST', '/v1/validate/aql', $body . '{}', $headers)[0] === 400, 'Trailing JSON rejected');
check(probe('POST', '/v1/validate/aql', '{"operation":"execute","content":"x"}', $headers)[0] === 400, 'Operation override rejected');
check(probe('POST', '/v1/validate/aql', '{"content":"x","url":"https://attacker.example"}', $headers)[0] === 422, 'Remote retrieval input rejected');
check(probe('POST', '/v1/validate/aql', str_repeat(' ', 8388609), $headers)[0] === 413, 'Request size limit enforced');
[$status, $result] = probe('POST', '/v1/validate/aql', $body, $headers);
check($status === 200 && $result['ok'] && $result['data']['valid'], 'Real native worker remains healthy after rejected inputs');
check(!str_contains(json_encode($result), $key), 'Service credential absent from engine result');
