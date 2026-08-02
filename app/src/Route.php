<?php

declare(strict_types=1);

namespace Agentic\Dashboard;

/**
 * Route patterns use a single {name} placeholder per segment. A regex router
 * would handle more, and this application has four routes, so the extra
 * capability would cost readability and buy nothing.
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
