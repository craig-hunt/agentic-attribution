<?php

declare(strict_types=1);

namespace Agentic\Dashboard;

/**
 * One class per file, named for the class. PSR-4 resolves a class name to a
 * path, so a second class sharing a file loads only when something already
 * pulled that file in for another reason. It works until the first caller that
 * touches this one first, and then it fatals.
 */
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
