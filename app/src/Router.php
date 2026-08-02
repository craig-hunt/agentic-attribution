<?php

declare(strict_types=1);

namespace Agentic\Dashboard;

final class Router
{
    /** @var list<Route> */
    private array $routes = [];

    /** @param callable(array<string, string>, array<string, string>): Response $handler */
    public function get(string $pattern, callable $handler): void
    {
        $this->routes[] = new Route('GET', $pattern, $handler);
    }

    public function post(string $pattern, callable $handler): void
    {
        $this->routes[] = new Route('POST', $pattern, $handler);
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
