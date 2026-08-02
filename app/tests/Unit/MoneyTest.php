<?php

declare(strict_types=1);

namespace Agentic\Dashboard\Tests\Unit;

use Agentic\Dashboard\Money;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class MoneyTest extends TestCase
{
    /**
     * Amounts cross every boundary in this system as integer cents. A ledger
     * storing 0.1 + 0.2 in binary floating point produces 0.30000000000000004,
     * and reconciling that cent costs more than every other bug combined.
     */
    #[DataProvider('amounts')]
    public function testFormatsCentsAsCurrency(int $cents, string $currency, string $expected): void
    {
        self::assertSame($expected, Money::format($cents, $currency));
    }

    public static function amounts(): array
    {
        return [
            'whole dollars' => [12_900, 'USD', '$129.00'],
            'dollars and cents' => [12_999, 'USD', '$129.99'],
            'a single cent' => [1, 'USD', '$0.01'],
            'nine cents pads to two places' => [9, 'USD', '$0.09'],
            'ten cents needs no padding' => [10, 'USD', '$0.10'],
            'zero' => [0, 'USD', '$0.00'],
            'thousands separate' => [123_456_789, 'USD', '$1,234,567.89'],
            'exactly one thousand dollars' => [100_000, 'USD', '$1,000.00'],
            'euro' => [1_000, 'EUR', '€10.00'],
            'sterling' => [1_000, 'GBP', '£10.00'],
            'unknown currency suffixes instead' => [1_000, 'JPY', '10.00 JPY'],
        ];
    }

    /**
     * The sign sits outside the symbol. A ledger debit rendered as "$-5.00"
     * reads as a malformed amount rather than as money owed.
     */
    #[DataProvider('debits')]
    public function testNegativeAmountsCarryTheSignOutsideTheSymbol(int $cents, string $expected): void
    {
        self::assertSame($expected, Money::format($cents));
    }

    public static function debits(): array
    {
        return [
            'whole' => [-500, '-$5.00'],
            'with cents' => [-58_401, '-$584.01'],
            'a single cent' => [-1, '-$0.01'],
        ];
    }

    #[DataProvider('rates')]
    public function testRendersBasisPointsAsAPercentage(int $bps, string $expected): void
    {
        self::assertSame($expected, Money::basisPoints($bps));
    }

    public static function rates(): array
    {
        return [
            'a typical rate' => [450, '4.5%'],
            'a whole percent' => [500, '5%'],
            'the full rate' => [10_000, '100%'],
            'nothing' => [0, '0%'],
            'the smallest step' => [1, '0.01%'],
            'two decimals' => [1_234, '12.34%'],
            'trailing zeroes trim' => [1_200, '12%'],
            'one trailing zero trims' => [1_250, '12.5%'],
        ];
    }

    /**
     * A confirmed settlement's three ledger entries offset to zero. Rendering
     * that total is how the dashboard shows the double entry balanced, so the
     * formatter has to survive the sum reaching it.
     */
    public function testTheBalancedLedgerTotalRendersAsZero(): void
    {
        $entries = [-584, 175, 409];

        self::assertSame('$0.00', Money::format(array_sum($entries)));
    }
}
