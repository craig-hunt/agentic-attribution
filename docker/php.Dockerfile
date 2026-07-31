FROM php:8.3-cli-alpine

# The dashboard's only extension requirement. JSON is compiled in on PHP 8.
RUN apk add --no-cache curl-dev \
    && docker-php-ext-install curl

WORKDIR /app

COPY app/ ./

# No composer install. A hand-rolled PSR-4 autoloader keeps the runtime free of
# dependencies, so this image needs no install step and no vendor directory.
USER www-data

EXPOSE 8000

CMD ["php", "-S", "0.0.0.0:8000", "-t", "public"]
