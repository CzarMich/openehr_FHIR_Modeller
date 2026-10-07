ARG PHP_IMAGE=php:8.4-fpm-alpine@sha256:31b521b84d17a97481ce722068c0b9332e78f73624fc44779a26c15d12cd0111

#
# Application base
#
FROM ${PHP_IMAGE} AS base
COPY --chmod=0755 --from=mlocati/php-extension-installer@sha256:1afade3e29cfc97362cf5885e5ac333bf2faab1146cb28ebbb59b17e68f87e88 /usr/bin/install-php-extensions /usr/local/bin/
# Install extensions and tools
RUN set -eux \
    && apk update && apk upgrade --no-cache \
    && apk add --no-cache \
      ca-certificates fcgi git openssh-client \
    && install-php-extensions pdo_pgsql redis-6.3.0 \
    && update-ca-certificates \
    && mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"
# Add production PHP INI overlays (keep extension configs clean in .docker/php)
COPY .docker/php/opcache.ini /usr/local/etc/php/conf.d/
COPY .docker/php/zz-overwrites.ini /usr/local/etc/php/conf.d/
COPY .docker/php-fpm.d/docker.conf /usr/local/etc/php-fpm.d/
ENV APP_ENV=production
# Source code location
WORKDIR /app
EXPOSE 9000
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 CMD SCRIPT_NAME=/health/status SCRIPT_FILENAME=/health/status REQUEST_METHOD=GET cgi-fcgi -bind -connect 127.0.0.1:9000 | grep -q ok


FROM base AS development
# Development-specific settings and tools only
ENV APP_ENV=development
COPY .docker/php/zz-development.ini /usr/local/etc/php/conf.d/
# Defining XDG Base Directories for composer
ENV XDG_CONFIG_HOME=/data/.config
ENV XDG_CACHE_HOME=/data/.cache
# Install PHP extensions and minimal OS tools in a single layer
COPY --chmod=0755 --from=mlocati/php-extension-installer@sha256:1afade3e29cfc97362cf5885e5ac333bf2faab1146cb28ebbb59b17e68f87e88 /usr/bin/install-php-extensions /usr/local/bin/
RUN set -eux \
    && mv "$PHP_INI_DIR/php.ini-development" "$PHP_INI_DIR/php.ini" \
    && adduser -S -u 1000 -G www-data local-user \
    && apk add --no-cache \
      git \
    && install-php-extensions \
      xdebug \
      @composer \
    && mkdir -m 0775 -p "$XDG_CONFIG_HOME/composer" "$XDG_CACHE_HOME/composer" \
    && chown -R local-user:www-data "$XDG_CONFIG_HOME/composer" "$XDG_CACHE_HOME/composer"
USER www-data

#
# PHP Dependencies builder (production deps only)
#
FROM base AS vendor-builder
COPY composer.json ./composer.json
COPY composer.lock ./composer.lock
COPY --from=composer:2@sha256:9715c7f69044da2a212a5fbde29ee7da24e364d426560ae6367b060236f847d7 /usr/bin/composer /usr/bin/composer
RUN composer install --no-interaction --no-progress --no-ansi --no-scripts --no-dev --no-autoloader
COPY public ./public
COPY src ./src
RUN composer dump-autoload --no-dev --no-scripts --classmap-authoritative


#
# Application (production)
#
FROM base AS runtime
LABEL org.opencontainers.image.authors="Michael Anywar" \
      org.opencontainers.image.vendor="Michael Anywar" \
      org.opencontainers.image.licenses="MIT"
COPY --from=vendor-builder /app/public ./public
COPY --from=vendor-builder /app/src ./src
COPY --from=vendor-builder /app/vendor ./vendor
COPY resources ./resources
COPY scripts/governance-storage.php ./scripts/governance-storage.php
COPY deploy/postgres/001-governance.sql ./deploy/postgres/001-governance.sql
COPY LICENSE THIRD_PARTY_NOTICES.md ./
RUN mkdir -p /data/models /data/governance /data/cdr && chown -R www-data:www-data /data
ENV MODEL_REPOSITORY_PATH=/data/models
STOPSIGNAL SIGQUIT
USER www-data

#
# Node + curl for MCP conformance (npx) and scripts (dev only)
#
FROM node:22-alpine AS node
RUN apk add --no-cache curl
WORKDIR /app

#
# MCP Inspector v2 + an OS keyring (dev only)
#
# Pinned by digest: `:latest` moved to the v2.0.0 rewrite on 2026-07-28. v2 keeps
# per-server secrets in an OS keychain, which the upstream image cannot reach in a
# container — see .docker/inspector-entrypoint.sh for the failure and the fix.
#
FROM ghcr.io/modelcontextprotocol/inspector:2.0.0@sha256:69bc9110a70afbdd5137af4cbd30636e889b9ce16776f1f3226d1aa8fcd1acb7 AS inspector
USER root
RUN set -eux \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      dbus-x11 \
      gnome-keyring \
      libsecret-1-0 \
    && rm -rf /var/lib/apt/lists/*
COPY .docker/inspector-entrypoint.sh /usr/local/bin/inspector-entrypoint
RUN chmod +x /usr/local/bin/inspector-entrypoint
USER node
ENTRYPOINT ["/usr/local/bin/inspector-entrypoint"]
CMD ["--web"]

FROM caddy:2-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b AS ingress
# We serve an unprivileged port. Remove the image's file capability so cap_drop=ALL works.
RUN setcap -r /usr/bin/caddy
USER 1000:1000

# Immutable local Dev delivery targets. Existing Dev data belongs to UID 1000.
FROM runtime AS fhir-dev
USER root
COPY .docker/php/zz-fhir-runtime.ini /usr/local/etc/php/conf.d/
RUN chown -R 1000:1000 /data
USER 1000:1000

FROM ingress AS fhir-dev-ingress
COPY .docker/Caddyfile /etc/caddy/Caddyfile

# The default build is the production PHP-FPM image.
FROM runtime AS production
