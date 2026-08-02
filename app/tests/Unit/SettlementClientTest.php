<?php

declare(strict_types=1);

namespace Agentic\Dashboard\Tests\Unit;

use Agentic\Dashboard\SettlementClient;
use Agentic\Dashboard\UpstreamException;
use PHPUnit\Framework\TestCase;

/**
 * Exercised against a real HTTP server rather than a mocked cURL handle.
 *
 * The client's behaviour lives in how it treats status codes and bodies, and a
 * fake would have to reproduce cURL's own semantics to test that honestly. A
 * local server on an ephemeral port costs a second and tests the real thing.
 */
final class SettlementClientTest extends TestCase
{
    private const PORT = 18432;

    /** @var resource|null */
    private static $server = null;

    public static function setUpBeforeClass(): void
    {
        $router = __DIR__ . '/../fixtures/upstream/router.php';

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

        self::fail('the stub upstream never accepted connections');
    }

    public static function tearDownAfterClass(): void
    {
        if (is_resource(self::$server)) {
            proc_terminate(self::$server);
            proc_close(self::$server);
        }
    }

    private function client(): SettlementClient
    {
        return new SettlementClient('http://127.0.0.1:' . self::PORT);
    }

    public function testPublishersDecodesTheList(): void
    {
        $publishers = $this->client()->publishers();

        self::assertCount(1, $publishers);
        self::assertSame('pub_000001', $publishers[0]['publisher_id']);
        // The list carries activity totals so the dashboard can rank by them.
        self::assertSame(2, $publishers[0]['settlement_count']);
        self::assertSame(500, $publishers[0]['earned_cents']);
        self::assertSame('Trail & Peak', $publishers[0]['name']);
    }

    public function testPublisherSendsTheLimitAndReturnsBothHalves(): void
    {
        $data = $this->client()->publisher('pub_000001', 25);

        self::assertSame('pub_000001', $data['summary']['publisher_id']);
        self::assertCount(1, $data['settlements']);
        self::assertSame('limit=25', $data['echoed_query']);
    }

    /**
     * Identifiers reach the client from the address bar, so one carrying a
     * slash or a space has to encode rather than change which endpoint gets
     * called.
     */
    public function testIdentifiersAreUrlEncoded(): void
    {
        $data = $this->client()->publisher('pub 0001/../admin', 10);

        self::assertStringNotContainsString('/admin', $data['echoed_path']);
        self::assertStringContainsString('%20', $data['echoed_path']);
    }

    public function testChainTargetsTheChainEndpoint(): void
    {
        $chain = $this->client()->chain('stl_1');

        self::assertSame('stl_1', $chain['settlement_id']);
        self::assertStringEndsWith('/chain', $chain['echoed_path']);
    }

    /**
     * An upstream 404 has to arrive as a 404 rather than collapsing into a 500,
     * because the dashboard links to identifiers a reader can edit.
     */
    public function testAnUpstreamErrorCarriesItsStatusAndReason(): void
    {
        try {
            $this->client()->publisher('broken');
            self::fail('a 404 upstream did not throw');
        } catch (UpstreamException $error) {
            self::assertSame(404, $error->status);
            self::assertSame('publisher_not_found', $error->reason);
            self::assertStringContainsString('publisher not found', $error->getMessage());
        }
    }

    /**
     * A proxy answering with HTML must not surface as a JSON parse error. The
     * status the caller needs is already in hand.
     */
    public function testANonJsonErrorBodyBecomesAnUpstreamFailure(): void
    {
        try {
            $this->client()->publisher('html');
            self::fail('an HTML error body did not throw');
        } catch (UpstreamException $error) {
            self::assertSame(502, $error->status);
            self::assertSame('upstream_malformed', $error->reason);
        }
    }

    public function testAMalformedSuccessBodyIsRefused(): void
    {
        try {
            $this->client()->publisher('garbage');
            self::fail('an unparseable 200 did not throw');
        } catch (UpstreamException $error) {
            self::assertSame('upstream_malformed', $error->reason);
            self::assertGreaterThanOrEqual(400, $error->status);
        }
    }

    /**
     * An unreachable service is a 502 rather than an exception the dashboard
     * cannot classify, and the message has to say the service was unreachable
     * rather than reporting a cURL error code.
     */
    public function testAnUnreachableServiceReportsAsABadGateway(): void
    {
        $client = new SettlementClient('http://127.0.0.1:1');

        try {
            $client->publishers();
            self::fail('an unreachable service did not throw');
        } catch (UpstreamException $error) {
            self::assertSame(502, $error->status);
            self::assertSame('upstream_unreachable', $error->reason);
            self::assertStringContainsString('unreachable', $error->getMessage());
        }
    }
}
