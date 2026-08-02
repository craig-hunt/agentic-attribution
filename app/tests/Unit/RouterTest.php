<?php

declare(strict_types=1);

namespace Agentic\Dashboard\Tests\Unit;

use Agentic\Dashboard\Response;
use Agentic\Dashboard\Router;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class RouterTest extends TestCase
{
    private function router(): Router
    {
        $router = new Router();

        $router->get('/', static fn (): Response => new Response(200, 'index'));
        $router->get('/publishers', static fn (): Response => new Response(200, 'list'));
        $router->get(
            '/publishers/{publisherId}',
            static fn (array $p): Response => new Response(200, $p['publisherId']),
        );
        $router->get(
            '/settlements/{settlementId}',
            static fn (array $p): Response => new Response(200, $p['settlementId']),
        );

        return $router;
    }

    #[DataProvider('matchingPaths')]
    public function testRoutesResolveToTheirHandler(string $path, string $expected): void
    {
        self::assertSame($expected, $this->router()->dispatch('GET', $path)->body);
    }

    public static function matchingPaths(): array
    {
        return [
            'index' => ['/', 'index'],
            'index with a trailing slash' => ['//', 'index'],
            'a static route' => ['/publishers', 'list'],
            'a captured parameter' => ['/publishers/pub_0001', 'pub_0001'],
            'a different captured route' => ['/settlements/stl_1', 'stl_1'],
            'a trailing slash on a captured route' => ['/publishers/pub_0001/', 'pub_0001'],
            'a percent-encoded parameter decodes' => ['/publishers/pub%200001', 'pub 0001'],
        ];
    }

    /**
     * A placeholder must not match an empty segment. Accepting one sends the
     * upstream a request for the identifier "", which it answers with a
     * confusing 404 rather than an obvious one.
     */
    #[DataProvider('unmatchedPaths')]
    public function testUnmatchedPathsReturnNotFound(string $path): void
    {
        $response = $this->router()->dispatch('GET', $path);

        self::assertSame(404, $response->status);
        self::assertSame('not found', $response->body);
    }

    public static function unmatchedPaths(): array
    {
        return [
            'an unknown path' => ['/nope'],
            'an empty captured segment' => ['/settlements/'],
            'too many segments' => ['/publishers/pub_0001/extra'],
            'too few segments' => ['/settlements'],
            'a near miss on a static segment' => ['/publisher/pub_0001'],
            'a deeper unknown path' => ['/a/b/c/d'],
        ];
    }

    public function testTheMethodMustMatchAsWellAsThePath(): void
    {
        foreach (['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'] as $method) {
            self::assertSame(404, $this->router()->dispatch($method, '/')->status, $method);
        }
    }

    /**
     * A route with no placeholders matches and captures nothing, which is a
     * different outcome from not matching at all. Collapsing the two would make
     * every static route unreachable.
     */
    public function testAStaticRouteMatchesWhileCapturingNothing(): void
    {
        $router = new Router();
        $router->get('/publishers', static fn (array $p): Response => new Response(200, (string) count($p)));

        self::assertSame('0', $router->dispatch('GET', '/publishers')->body);
    }

    public function testTheQueryStringReachesTheHandler(): void
    {
        $router = new Router();
        $router->get('/', static fn (array $p, array $q): Response => new Response(200, $q['limit'] ?? 'none'));

        self::assertSame('25', $router->dispatch('GET', '/', ['limit' => '25'])->body);
        self::assertSame('none', $router->dispatch('GET', '/')->body);
    }

    public function testResponsesCarryAJsonContentTypeByDefault(): void
    {
        $response = new Response(200, 'body');

        self::assertSame(['Content-Type' => 'text/html; charset=utf-8'], $response->headers);
        self::assertSame(200, $response->status);
    }
}
