<?php

declare(strict_types=1);

// A stand-in settlement service. Each path exercises one branch of
// SettlementClient: a good response, an upstream error carrying JSON, a
// non-JSON body from a proxy, and a body that never parses.
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

if (str_starts_with($path, '/publishers/broken')) {
    http_response_code(404);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'publisher not found', 'reason' => 'publisher_not_found']);
    return true;
}

if (str_starts_with($path, '/publishers/html')) {
    http_response_code(502);
    header('Content-Type: text/html');
    echo '<html>502 Bad Gateway</html>';
    return true;
}

if (str_starts_with($path, '/publishers/garbage')) {
    header('Content-Type: application/json');
    echo 'not json at all';
    return true;
}

if ($path === '/publishers') {
    header('Content-Type: application/json');
    echo json_encode(['publishers' => [
        [
            'publisher_id' => 'pub_000001',
            'name' => 'Trail & Peak',
            'payout_currency' => 'USD',
            'settlement_count' => 2,
            'earned_cents' => 500,
            'blocked_count' => 1,
            'failed_count' => 0,
        ],
    ]]);
    return true;
}

if (str_starts_with($path, '/publishers/')) {
    header('Content-Type: application/json');
    echo json_encode([
        'summary' => ['publisher_id' => 'pub_000001', 'name' => 'Trail & Peak', 'payout_currency' => 'USD'],
        'settlements' => [['settlement_id' => 'stl_1']],
        'echoed_query' => $_SERVER['QUERY_STRING'] ?? '',
        'echoed_path' => $path,
    ]);
    return true;
}

if (str_ends_with($path, '/chain')) {
    header('Content-Type: application/json');
    echo json_encode(['settlement_id' => 'stl_1', 'echoed_path' => $path]);
    return true;
}

http_response_code(404);
header('Content-Type: application/json');
echo json_encode(['error' => 'not found', 'reason' => 'not_found']);
return true;
