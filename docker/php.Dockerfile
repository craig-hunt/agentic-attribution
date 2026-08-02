FROM php:8.3-cli-alpine AS base

# The dashboard's only extension requirement. JSON is compiled in on PHP 8.
RUN apk add --no-cache curl-dev \
    && docker-php-ext-install curl

WORKDIR /app

# The test stage adds what PHPUnit and Infection need and nothing the runtime
# uses. pcov rather than xdebug: Infection needs line coverage, and pcov costs
# a fraction of xdebug's overhead for exactly that.
FROM base AS test

RUN apk add --no-cache --virtual .build-deps $PHPIZE_DEPS git unzip \
    && pecl install pcov \
    && docker-php-ext-enable pcov \
    && apk del .build-deps

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

COPY app/composer.json app/composer.lock* ./
RUN composer install --no-interaction --no-scripts --prefer-dist

COPY app/ ./

CMD ["./vendor/bin/phpunit", "--no-progress"]

# The runtime carries no composer, no vendor directory, and no dev tooling. A
# hand-rolled PSR-4 autoloader keeps it that way, so the image a reviewer runs
# needs no install step.
FROM base AS runtime

COPY app/ ./

USER www-data

EXPOSE 8000

CMD ["php", "-S", "0.0.0.0:8000", "-t", "public"]
