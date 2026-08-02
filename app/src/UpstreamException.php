<?php

declare(strict_types=1);

namespace Agentic\Dashboard;

use RuntimeException;

/**
 * Thrown when the settlement service answers with anything other than success.
 *
 * Carrying the status lets the router translate an upstream 404 into a 404 the
 * browser sees, rather than collapsing every upstream failure into a 500.
 */
final class UpstreamException extends RuntimeException
{
    public function __construct(
        string $message,
        public readonly int $status,
        public readonly string $reason = '',
    ) {
        parent::__construct($message);
    }
}
