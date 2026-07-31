<?php

declare(strict_types=1);

use function Agentic\Dashboard\e;

/** @var int $status */
/** @var string $message */
?>
<h1><?= e((string) $status) ?></h1>
<div class="err"><?= e($message) ?></div>
<p><a href="/">Back to publishers</a></p>
