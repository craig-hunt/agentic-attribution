<?php

declare(strict_types=1);

namespace Agentic\Dashboard\Tests\Unit;

use Agentic\Dashboard\DriverClient;
use Agentic\Dashboard\UpstreamException;
use PHPUnit\Framework\TestCase;

/**
 * Exercised against a real HTTP server for the same reason SettlementClient is.
 * The behaviour worth testing lives in how the client shapes a request and
 * reads a status code, and a mocked cURL handle would test the mock.
 */
final class DriverClientTest extends TestCase
{
    private const PORT = 18433;

    /** @var resource|null */
    private static $server = null;

    public static function setUpBeforeClass(): void
    {
        $router = __DIR__ . '/../fixtures/upstream/driver.php';

        self::$server = proc_open(
            sprintf('exec php -S 127.0.0.1:%d %s', self::PORT, escapeshellarg($router)),
            [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']],
            $pipes,
        );

        for ($i = 0; $i < 100; $i++) {
            $probe = @fsockopen('127.0.0.1', self::PORT, $errno, $errstr, 0.1);
            if ($probe !== false) {
                fclose($probe);
                return;
            }
            usleep(50_000);
        }

        self::fail('the stub driver never accepted connections');
    }

    public static function tearDownAfterClass(): void
    {
        if (is_resource(self::$server)) {
            proc_terminate(self::$server);
            proc_close(self::$server);
        }
    }

    private function client(): DriverClient
    {
        return new DriverClient('http://127.0.0.1:' . self::PORT);
    }

    public function testStatusReadsWithoutSendingABody(): void
    {
        $status = $this->client()->status();

        self::assertSame('GET', $status['echoed_method']);
        self::assertStringEndsWith('/status', $status['echoed_path']);
        // A GET carrying a body would make an intermediary drop or rewrite it.
        self::assertNull($status['echoed_body']);
        self::assertSame(2, $status['settled']);
    }

    public function testStartSendsConcurrencyAndFraudRate(): void
    {
        $status = $this->client()->start(8, 0.35);

        self::assertSame('POST', $status['echoed_method']);
        self::assertStringEndsWith('/start', $status['echoed_path']);
        self::assertSame(8, $status['echoed_body']['concurrency']);
        self::assertSame(0.35, $status['echoed_body']['fraud_rate']);
        self::assertTrue($status['running']);
    }

    /**
     * A single run has no population to average over, so the caller decides the
     * rate outright and the client must pass it through rather than defaulting.
     */
    public function testOnceSendsOnlyTheFraudRate(): void
    {
        $status = $this->client()->once(1.0);

        self::assertSame('POST', $status['echoed_method']);
        self::assertStringEndsWith('/once', $status['echoed_path']);
        self::assertEquals(1, $status['echoed_body']['fraud_rate']);
        self::assertArrayNotHasKey('concurrency', $status['echoed_body']);
    }

    public function testStopSendsNoBody(): void
    {
        $status = $this->client()->stop();

        self::assertSame('POST', $status['echoed_method']);
        self::assertStringEndsWith('/stop', $status['echoed_path']);
        self::assertNull($status['echoed_body']);
        self::assertFalse($status['running']);
    }

    /**
     * The driver refuses to start before the catalog is seeded, and that reason
     * has to reach the page. Swallowing it would leave someone pressing a
     * button that silently does nothing.
     */
    public function testAnErrorResponseSurfacesItsReason(): void
    {
        $client = new DriverClient('http://127.0.0.1:' . self::PORT . '/broken');

        try {
            $client->status();
            self::fail('a 503 did not raise');
        } catch (UpstreamException $error) {
            self::assertSame(503, $error->status);
            self::assertSame('not_seeded', $error->reason);
            self::assertStringContainsString('no publishers', $error->getMessage());
        }
    }

    public function testANonJsonBodyRaisesRatherThanParsing(): void
    {
        $client = new DriverClient('http://127.0.0.1:' . self::PORT . '/html');

        try {
            $client->status();
            self::fail('an HTML body did not raise');
        } catch (UpstreamException $error) {
            self::assertSame(502, $error->status);
            self::assertSame('upstream_malformed', $error->reason);
        }
    }

    public function testAnUnreachableDriverRaisesRatherThanHanging(): void
    {
        // Port 1 refuses immediately on every platform this runs on.
        $client = new DriverClient('http://127.0.0.1:1');

        try {
            $client->status();
            self::fail('an unreachable driver did not raise');
        } catch (UpstreamException $error) {
            self::assertSame(502, $error->status);
            self::assertSame('upstream_unreachable', $error->reason);
            self::assertStringContainsString('driver unreachable', $error->getMessage());
        }
    }
}
