<?php

declare(strict_types=1);

use Agentic\Dashboard\Response;
use Agentic\Dashboard\Router;
use Agentic\Dashboard\SettlementClient;
use Agentic\Dashboard\UpstreamException;
use Agentic\Dashboard\View;

require __DIR__ . '/../src/bootstrap.php';

const DEFAULT_SETTLEMENT_URL = 'http://localhost:8082';
const SETTLEMENT_PAGE_SIZE = 25;

$settlementUrl = getenv('SETTLEMENT_URL') ?: DEFAULT_SETTLEMENT_URL;

$client = new SettlementClient($settlementUrl);
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
        ['summary' => $data['summary'], 'settlements' => $data['settlements']],
    );
});

$router->get('/settlements/{settlementId}', static function (array $parameters) use ($client, $page): Response {
    return $page('Attribution chain', 'chain', ['chain' => $client->chain($parameters['settlementId'])]);
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
