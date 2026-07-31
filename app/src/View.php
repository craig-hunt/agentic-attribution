<?php

declare(strict_types=1);

namespace Agentic\Dashboard;

/**
 * Renders a PHP template with its variables scoped to the render call.
 *
 * Every value reaching a template passes through e() rather than being trusted.
 * Product titles, merchant names, and query text all originate in generated or
 * user-supplied data, and a dashboard that interpolates them raw is one
 * malicious merchant feed away from stored XSS.
 */
final readonly class View
{
    public function __construct(private string $templateDirectory)
    {
    }

    /** @param array<string, mixed> $data */
    public function render(string $template, array $data = []): string
    {
        $path = $this->templateDirectory . '/' . $template . '.php';

        if (!is_file($path)) {
            throw new \RuntimeException("template not found: {$template}");
        }

        // extract() is scoped to this method, so a template variable cannot
        // collide with anything the caller holds.
        extract($data, EXTR_SKIP);

        ob_start();

        try {
            require $path;

            return (string) ob_get_clean();
        } catch (\Throwable $error) {
            // Without this the buffer stays open and the partial output leaks
            // into whatever renders next.
            ob_end_clean();

            throw $error;
        }
    }
}

/**
 * HTML-escapes a value for output. Named short because it appears on every
 * interpolation in every template, and a long name invites skipping it.
 */
function e(mixed $value): string
{
    return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}
