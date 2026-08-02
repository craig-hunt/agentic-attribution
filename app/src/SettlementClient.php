<?php

declare(strict_types=1);

namespace Agentic\Dashboard;

/**
 * Reads the dashboard's data from the settlement service rather than from
 * Postgres. The schema stays private to the service that owns it, so a column
 * rename never becomes a coordinated deploy across two languages.
 */
final readonly class SettlementClient
{
    private const TIMEOUT_SECONDS = 10;
    private const CONNECT_TIMEOUT_SECONDS = 3;

    public function __construct(private string $baseUrl)
    {
    }

    /** @return list<array{publisher_id: string, name: string, payout_currency: string}> */
    public function publishers(): array
    {
        /** @var array{publishers: list<array{publisher_id: string, name: string, payout_currency: string, settlement_count: int, earned_cents: int}>} $body */
        $body = $this->get('/publishers');

        return $body['publishers'];
    }

    /** @return array{summary: array<string, mixed>, settlements: list<array<string, mixed>>, rejections: list<array<string, mixed>>} */
    public function publisher(string $publisherId, int $limit = 25): array
    {
        /** @var array{summary: array<string, mixed>, settlements: list<array<string, mixed>>, rejections: list<array<string, mixed>>} $body */
        $body = $this->get('/publishers/' . rawurlencode($publisherId) . '?limit=' . $limit);

        return $body;
    }

    /** @return array<string, mixed> */
    public function chain(string $settlementId): array
    {
        return $this->get('/settlements/' . rawurlencode($settlementId) . '/chain');
    }

    /** @return array<string, mixed> */
    private function get(string $path): array
    {
        $handle = curl_init($this->baseUrl . $path);

        if ($handle === false) {
            throw new UpstreamException('could not initialise the HTTP client', 500);
        }

        curl_setopt_array($handle, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => self::TIMEOUT_SECONDS,
            CURLOPT_CONNECTTIMEOUT => self::CONNECT_TIMEOUT_SECONDS,
            CURLOPT_HTTPHEADER => ['Accept: application/json'],
        ]);

        $response = curl_exec($handle);
        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        $error = curl_error($handle);
        curl_close($handle);

        if ($response === false) {
            throw new UpstreamException(
                'settlement service unreachable: ' . $error,
                502,
                'upstream_unreachable',
            );
        }

        /** @var string $response */
        $decoded = json_decode($response, true);

        // An upstream answering with HTML from a proxy, or with a truncated
        // body, must not surface as a JSON parse error. The status the caller
        // needs is already in hand.
        if (!is_array($decoded)) {
            throw new UpstreamException(
                'settlement service returned a non-JSON body',
                $status >= 400 ? $status : 502,
                'upstream_malformed',
            );
        }

        if ($status >= 400) {
            throw new UpstreamException(
                is_string($decoded['error'] ?? null) ? $decoded['error'] : 'upstream error',
                $status,
                is_string($decoded['reason'] ?? null) ? $decoded['reason'] : '',
            );
        }

        return $decoded;
    }
}
