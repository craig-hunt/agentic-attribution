<?php

declare(strict_types=1);

use Agentic\Dashboard\DriverClient;
use Agentic\Dashboard\Response;
use Agentic\Dashboard\Router;
use Agentic\Dashboard\SettlementClient;
use Agentic\Dashboard\UpstreamException;
use Agentic\Dashboard\View;

require __DIR__ . '/../src/bootstrap.php';

const DEFAULT_SETTLEMENT_URL = 'http://localhost:8082';
const DEFAULT_DRIVER_URL = 'http://localhost:8096';
const DEFAULT_FACILITATOR_URL = 'http://localhost:8095';
const SETTLEMENT_PAGE_SIZE = 25;

// Bounds on what the browser may ask the driver for. The control endpoints sit
// behind this proxy with no authentication of their own, so the ceiling lives
// here rather than in whatever the page happens to post.
const MAX_CONCURRENCY = 24;
const MIN_CONCURRENCY = 1;

$settlementUrl = getenv('SETTLEMENT_URL') ?: DEFAULT_SETTLEMENT_URL;
$driverUrl = getenv('DRIVER_URL') ?: DEFAULT_DRIVER_URL;
$facilitatorUrl = getenv('FACILITATOR_URL') ?: DEFAULT_FACILITATOR_URL;

$client = new SettlementClient($settlementUrl);
$driver = new DriverClient($driverUrl);

$json = static function (array $body, int $status = 200): Response {
    return new Response(
        $status,
        json_encode($body, JSON_THROW_ON_ERROR),
        ['Content-Type' => 'application/json', 'Cache-Control' => 'no-store'],
    );
};

/**
 * The page posts whatever its controls hold. Clamping here means a crafted
 * request cannot ask for a thousand concurrent agents against a laptop.
 */
$controls = static function (): array {
    $body = json_decode(file_get_contents('php://input') ?: '[]', true);
    $body = is_array($body) ? $body : [];

    $concurrency = (int) ($body['concurrency'] ?? 6);
    $fraudRate = (float) ($body['fraud_rate'] ?? 0.0);

    return [
        max(MIN_CONCURRENCY, min(MAX_CONCURRENCY, $concurrency)),
        max(0.0, min(1.0, $fraudRate)),
    ];
};
$view = new View(__DIR__ . '/../templates');

$page = static function (string $title, string $template, array $data) use ($view): Response {
    return new Response(200, $view->render('layout', [
        'title' => $title,
        'content' => $view->render($template, $data),
    ]));
};

$router = new Router();

$router->get('/', static function () use ($client, $page): Response {
    return $page('Publishers', 'publishers', ['publishers' => $client->publishers()]);
});

$router->get('/publishers/{publisherId}', static function (array $parameters) use ($client, $page): Response {
    $data = $client->publisher($parameters['publisherId'], SETTLEMENT_PAGE_SIZE);

    return $page(
        is_string($data['summary']['name'] ?? null) ? $data['summary']['name'] : 'Publisher',
        'publisher',
        [
            'summary' => $data['summary'],
            'settlements' => $data['settlements'],
            'rejections' => $data['rejections'] ?? [],
        ],
    );
});

$router->get('/settlements/{settlementId}', static function (array $parameters) use ($client, $page): Response {
    return $page('Attribution chain', 'chain', ['chain' => $client->chain($parameters['settlementId'])]);
});

// Polled by the dashboard rather than reloading the page, so a live run
// updates numbers in place without losing scroll position or selection.
$router->get('/api/publishers', static function () use ($client, $json): Response {
    return $json(['publishers' => $client->publishers()]);
});

$router->get('/api/publishers/{publisherId}', static function (array $parameters) use ($client, $json): Response {
    return $json($client->publisher($parameters['publisherId'], SETTLEMENT_PAGE_SIZE));
});

$router->get('/api/driver/status', static function () use ($driver, $json): Response {
    return $json($driver->status());
});

$router->post('/api/driver/start', static function () use ($driver, $json, $controls): Response {
    [$concurrency, $fraudRate] = $controls();

    return $json($driver->start($concurrency, $fraudRate));
});

$router->post('/api/driver/once', static function () use ($driver, $json, $controls): Response {
    [, $fraudRate] = $controls();

    return $json($driver->once($fraudRate));
});

$router->post('/api/driver/stop', static function () use ($driver, $json): Response {
    return $json($driver->stop());
});

// Proxied for the same reason the driver is: the facilitator publishes no
// port a browser can reach, and a regression suite needs to arm a fault, watch
// the platform handle it, and clear it again.
$router->post('/api/facilitator/fault', static function () use ($facilitatorUrl, $json): Response {
    $body = json_decode(file_get_contents('php://input') ?: '[]', true);
    $mode = is_array($body) && is_string($body['mode'] ?? null) ? $body['mode'] : '';

    $handle = curl_init($facilitatorUrl . '/fault');
    if ($handle === false) {
        return $json(['error' => 'could not initialise the HTTP client'], 500);
    }

    curl_setopt_array($handle, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 10,
        CURLOPT_CUSTOMREQUEST => 'POST',
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS => json_encode(['mode' => $mode], JSON_THROW_ON_ERROR),
    ]);

    $response = curl_exec($handle);
    $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
    $error = curl_error($handle);
    curl_close($handle);

    // Naming the transport error rather than swallowing it. A bare
    // "unreachable" sends whoever reads it looking at the network when the
    // cause is usually a URL this process never received.
    if ($response === false) {
        return $json(['error' => 'facilitator unreachable: ' . $error, 'url' => $facilitatorUrl], 502);
    }

    $decoded = json_decode((string) $response, true);

    return $json(is_array($decoded) ? $decoded : ['error' => 'facilitator returned a non-JSON body'], $status ?: 502);
});

$router->get('/healthz', static function (): Response {
    return new Response(200, '{"status":"ok"}', ['Content-Type' => 'application/json']);
});

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
parse_str((string) parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_QUERY), $query);

try {
    $response = $router->dispatch($_SERVER['REQUEST_METHOD'] ?? 'GET', is_string($path) ? $path : '/', $query);

    if ($response->status === 404 && $response->body === 'not found') {
        $response = new Response(404, $view->render('layout', [
            'title' => 'Not found',
            'content' => $view->render('error', ['status' => 404, 'message' => 'No such page.']),
        ]));
    }
} catch (UpstreamException $error) {
    // The upstream status passes through so a missing publisher reads as 404
    // rather than collapsing every upstream failure into a 500.
    $status = $error->status >= 400 && $error->status < 600 ? $error->status : 502;

    $response = new Response($status, $view->render('layout', [
        'title' => 'Error',
        'content' => $view->render('error', ['status' => $status, 'message' => $error->getMessage()]),
    ]));
}

http_response_code($response->status);

foreach ($response->headers as $name => $value) {
    header($name . ': ' . $value);
}

echo $response->body;
