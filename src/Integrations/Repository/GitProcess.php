<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Repository;

/** Bounded, noninteractive Git invocation. Arguments never pass through a shell. */
final readonly class GitProcess
{
    /** @param array<string, string> $environment */
    public function __construct(private string $directory, private int $timeout = 30, private array $environment = [])
    {
    }

    /** @param list<string> $arguments
     * @param array<string, string> $extraEnvironment
     * @return array{code: int, output: string}
     */
    public function run(array $arguments, string $input = '', array $extraEnvironment = []): array
    {
        $environment = array_replace([
            'PATH' => '/usr/local/bin:/usr/bin:/bin', 'GIT_TERMINAL_PROMPT' => '0',
            'GIT_CONFIG_NOSYSTEM' => '1', 'GIT_CONFIG_GLOBAL' => '/dev/null',
            'GIT_ATTR_NOSYSTEM' => '1', 'GIT_NO_REPLACE_OBJECTS' => '1',
            'GIT_ALLOW_PROTOCOL' => 'https:ssh:file', 'LC_ALL' => 'C',
        ], $this->environment, $extraEnvironment);
        $command = ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
            '-c', 'core.attributesFile=/dev/null', '-c', 'protocol.ext.allow=never',
            '-c', 'http.followRedirects=false', '-c', 'submodule.recurse=false', ...$arguments];
        // A temporary input stream avoids blocking on large artifact writes to stdin.
        $stdin = tmpfile();
        if ($stdin === false) {
            throw new \RuntimeException('GIT_IO_FAILED');
        }
        fwrite($stdin, $input);
        rewind($stdin);
        $process = proc_open($command, [$stdin, ['pipe', 'w'], ['pipe', 'w']], $pipes, $this->directory, $environment);
        if (!is_resource($process)) {
            fclose($stdin);
            throw new \RuntimeException('GIT_UNAVAILABLE');
        }
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);
        $output = ''; $bytes = 0; $started = microtime(true); $exit = -1;
        try {
            while (true) {
                $chunk = (string) stream_get_contents($pipes[1]);
                $error = (string) stream_get_contents($pipes[2]);
                $output .= $chunk;
                $bytes += strlen($chunk) + strlen($error);
                if ($bytes > 8388608) {
                    throw new \RuntimeException('GIT_OUTPUT_LIMIT');
                }
                $status = proc_get_status($process);
                if (!$status['running']) {
                    $exit = $status['exitcode'];
                    $tail = (string) stream_get_contents($pipes[1]);
                    $bytes += strlen($tail) + strlen((string) stream_get_contents($pipes[2]));
                    if ($bytes > 8388608) { throw new \RuntimeException('GIT_OUTPUT_LIMIT'); }
                    $output .= $tail;
                    break;
                }
                if (microtime(true) - $started > $this->timeout) {
                    throw new \RuntimeException('GIT_TIMEOUT');
                }
                usleep(10000);
            }
        } finally {
            if (proc_get_status($process)['running']) {
                proc_terminate($process, 9);
            }
            fclose($pipes[1]); fclose($pipes[2]); fclose($stdin);
            proc_close($process);
        }
        // Git stderr can contain remote configuration; it never reaches tools or logs.
        return ['code' => $exit, 'output' => $output];
    }
}
