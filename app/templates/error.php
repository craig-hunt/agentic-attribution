<?php

declare(strict_types=1);

use function Agentic\Dashboard\e;

/** @var int $status */
/** @var string $message */
?>
<h1 data-testid="error-status"><?= e((string) $status) ?></h1>
<div class="err" data-testid="error-message"><?= e($message) ?></div>
<p><a data-testid="error-home-link" href="/">Back to publishers</a></p>
