<?php

declare(strict_types=1);

// A stand-in driver service. Each path exercises one branch of DriverClient:
// a good response, an error carrying JSON, a non-JSON body from a proxy, and
// an echo so a test can assert the method and body that actually went out.
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$body = file_get_contents('php://input') ?: '';

if (str_starts_with($path, '/broken')) {
    http_response_code(503);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'no publishers in the catalog', 'reason' => 'not_seeded']);
    return true;
}

if (str_starts_with($path, '/html')) {
    http_response_code(502);
    header('Content-Type: text/html');
    echo '<html>502 Bad Gateway</html>';
    return true;
}

header('Content-Type: application/json');
echo json_encode([
    'running' => str_ends_with($path, '/start'),
    'started' => 3,
    'settled' => 2,
    'blocked' => 1,
    'failed' => 0,
    'echoed_method' => $method,
    'echoed_path' => $path,
    'echoed_body' => $body === '' ? null : json_decode($body, true),
]);

return true;
