<?php

declare(strict_types=1);

namespace Agentic\Dashboard;

final readonly class Response
{
    /** @param array<string, string> $headers */
    public function __construct(
        public int $status,
        public string $body,
        public array $headers = ['Content-Type' => 'text/html; charset=utf-8'],
    ) {
    }
}

/**
 * Route patterns use a single {name} placeholder segment. A regex router would
 * handle more, and this application has four routes, so the extra capability
 * would cost readability and buy nothing.
 */
final readonly class Route
{
    public function __construct(
        public string $method,
        public string $pattern,
        /** @var callable(array<string, string>, array<string, string>): Response */
        public mixed $handler,
    ) {
    }
}

final class Router
{
    /** @var list<Route> */
    private array $routes = [];

    /** @param callable(array<string, string>, array<string, string>): Response $handler */
    public function get(string $pattern, callable $handler): void
    {
        $this->routes[] = new Route('GET', $pattern, $handler);
    }

    /** @param array<string, string> $query */
    public function dispatch(string $method, string $path, array $query = []): Response
    {
        foreach ($this->routes as $route) {
            if ($route->method !== $method) {
                continue;
            }

            $parameters = self::match($route->pattern, $path);

            if ($parameters !== null) {
                return ($route->handler)($parameters, $query);
            }
        }

        return new Response(404, 'not found');
    }

    /**
     * Returns the captured parameters, or null when the pattern does not match.
     * Null rather than an empty array, because a route with no placeholders
     * matches and captures nothing, and those two cases must stay distinct.
     *
     * @return array<string, string>|null
     */
    private static function match(string $pattern, string $path): ?array
    {
        $patternSegments = explode('/', trim($pattern, '/'));
        $pathSegments = explode('/', trim($path, '/'));

        if (count($patternSegments) !== count($pathSegments)) {
            return null;
        }

        $parameters = [];

        foreach ($patternSegments as $index => $segment) {
            $actual = $pathSegments[$index] ?? '';

            if (str_starts_with($segment, '{') && str_ends_with($segment, '}')) {
                // An empty segment would match a placeholder and produce a
                // request for the identifier "", which the upstream answers
                // with a confusing 404 rather than an obvious one.
                if ($actual === '') {
                    return null;
                }

                $parameters[trim($segment, '{}')] = urldecode($actual);

                continue;
            }

            if ($segment !== $actual) {
                return null;
            }
        }

        return $parameters;
    }
}
