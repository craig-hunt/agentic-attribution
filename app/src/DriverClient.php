<?php

declare(strict_types=1);

namespace Agentic\Dashboard;

/**
 * Controls the live agent population from the dashboard.
 *
 * The driver holds no published port, so the browser never reaches it
 * directly. Proxying through here keeps the page same-origin, which avoids
 * CORS, and keeps a load generator off the host's network surface. The driver
 * has no authentication of its own, and that only stays acceptable while this
 * remains the sole route to it.
 */
final readonly class DriverClient
{
    private const TIMEOUT_SECONDS = 30;
    private const CONNECT_TIMEOUT_SECONDS = 3;

    public function __construct(private string $baseUrl)
    {
    }

    /** @return array<string, mixed> */
    public function status(): array
    {
        return $this->send('GET', '/status', null);
    }

    /** @return array<string, mixed> */
    public function start(int $concurrency, float $fraudRate): array
    {
        return $this->send('POST', '/start', [
            'concurrency' => $concurrency,
            'fraud_rate' => $fraudRate,
        ]);
    }

    /**
     * Fires exactly one purchase and waits for it. Someone meeting the demo
     * for the first time wants to watch a single transaction land before
     * turning on a population of them.
     *
     * @return array<string, mixed>
     */
    public function once(float $fraudRate): array
    {
        return $this->send('POST', '/once', ['fraud_rate' => $fraudRate]);
    }

    /** @return array<string, mixed> */
    public function stop(): array
    {
        return $this->send('POST', '/stop', null);
    }

    /**
     * @param array<string, mixed>|null $body
     *
     * @return array<string, mixed>
     */
    private function send(string $method, string $path, ?array $body): array
    {
        $handle = curl_init($this->baseUrl . $path);

        if ($handle === false) {
            throw new UpstreamException('could not initialise the HTTP client', 500);
        }

        $options = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => self::TIMEOUT_SECONDS,
            CURLOPT_CONNECTTIMEOUT => self::CONNECT_TIMEOUT_SECONDS,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => ['Accept: application/json', 'Content-Type: application/json'],
        ];

        if ($body !== null) {
            $options[CURLOPT_POSTFIELDS] = json_encode($body, JSON_THROW_ON_ERROR);
        }

        curl_setopt_array($handle, $options);

        $response = curl_exec($handle);
        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        $error = curl_error($handle);
        curl_close($handle);

        if ($response === false) {
            throw new UpstreamException(
                'driver unreachable: ' . $error,
                502,
                'upstream_unreachable',
            );
        }

        /** @var string $response */
        $decoded = json_decode($response, true);

        if (!is_array($decoded)) {
            throw new UpstreamException(
                'driver returned a non-JSON body',
                $status >= 400 ? $status : 502,
                'upstream_malformed',
            );
        }

        if ($status >= 400) {
            throw new UpstreamException(
                is_string($decoded['error'] ?? null) ? $decoded['error'] : 'driver error',
                $status,
                is_string($decoded['reason'] ?? null) ? $decoded['reason'] : '',
            );
        }

        return $decoded;
    }
}
