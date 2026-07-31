<?php

declare(strict_types=1);

namespace Agentic\Dashboard;

/**
 * Amounts cross every boundary in this system as integer cents and never as
 * floats. A ledger that stores 0.1 + 0.2 in binary floating point produces
 * 0.30000000000000004, and a reconciliation chasing that cent costs more than
 * every other bug in the system combined.
 */
final class Money
{
    private const CENTS_PER_UNIT = 100;

    public static function format(int $cents, string $currency = 'USD'): string
    {
        $symbol = match ($currency) {
            'USD' => '$',
            'EUR' => '€',
            'GBP' => '£',
            default => '',
        };

        $sign = $cents < 0 ? '-' : '';
        $absolute = abs($cents);

        $whole = intdiv($absolute, self::CENTS_PER_UNIT);
        $fraction = $absolute % self::CENTS_PER_UNIT;

        $formatted = number_format($whole) . '.' . str_pad((string) $fraction, 2, '0', STR_PAD_LEFT);

        return $sign . $symbol . $formatted . ($symbol === '' ? ' ' . $currency : '');
    }

    /**
     * Basis points render as a percentage with at most two decimals. 450 bps
     * reads as 4.5%, which is how a publisher thinks about a commission rate,
     * while the underlying integer stays exact everywhere else.
     */
    public static function basisPoints(int $bps): string
    {
        return rtrim(rtrim(number_format($bps / 100, 2), '0'), '.') . '%';
    }
}
