<?php

declare(strict_types=1);

/**
 * Autoloading without Composer, so the container runs on a stock php:8.3 image
 * and `docker compose up` needs no install step. Composer stays available for
 * the dev tooling; nothing at runtime requires it.
 */
const AGENTIC_NAMESPACE_PREFIX = 'Agentic\\Dashboard\\';

spl_autoload_register(static function (string $class): void {
    if (!str_starts_with($class, AGENTIC_NAMESPACE_PREFIX)) {
        return;
    }

    $relative = str_replace('\\', '/', substr($class, strlen(AGENTIC_NAMESPACE_PREFIX)));
    $path = __DIR__ . '/' . $relative . '.php';

    if (is_file($path)) {
        require $path;
    }
});

// The e() helper lives alongside View, and PHP does not autoload functions, so
// this file loads eagerly rather than on first class resolution.
require_once __DIR__ . '/View.php';
