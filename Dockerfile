ARG DOTNET_SDK=mcr.microsoft.com/dotnet/sdk:10.0.404@sha256:8c6edfb26c85153f236d26efebd9ad349aec403583f343f201ee67838b23658d
ARG DOTNET_RUNTIME=mcr.microsoft.com/dotnet/aspnet:10.0.15@sha256:aac50ceef10391e78a899e3d2ccd00bbafa2dcb56ccf4586cbccf00edb84fc21
FROM ${DOTNET_SDK} AS application-build
WORKDIR /src/dotnet
COPY dotnet/global.json ./
COPY dotnet/Modeller.Core/Modeller.Core.csproj dotnet/Modeller.Core/packages.lock.json Modeller.Core/
COPY dotnet/Modeller.Database/Modeller.Database.csproj dotnet/Modeller.Database/packages.lock.json Modeller.Database/
COPY dotnet/Modeller.Application/Modeller.Application.csproj dotnet/Modeller.Application/packages.lock.json Modeller.Application/
COPY dotnet/Modeller.Mcp/Modeller.Mcp.csproj dotnet/Modeller.Mcp/packages.lock.json Modeller.Mcp/
RUN dotnet restore Modeller.Mcp -r linux-x64 --locked-mode
COPY dotnet/ ./
RUN dotnet publish Modeller.Mcp -c Release -r linux-x64 --no-self-contained --no-restore -o /out -p:UseAppHost=false

FROM ${DOTNET_RUNTIME} AS runtime
LABEL org.opencontainers.image.authors="Michael Anywar" \
      org.opencontainers.image.vendor="Michael Anywar" \
      org.opencontainers.image.licenses="MIT"
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && usermod -u 1000 app && groupmod -g 1000 app \
    && mkdir -p /data/models /data/governance /data/cdr \
    && chown -R 1000:1000 /data
WORKDIR /app
COPY --from=application-build /out/ ./
COPY resources/ ./resources/
COPY VERSION LICENSE THIRD_PARTY_NOTICES.md ./
COPY dotnet/notices/ ./notices/
COPY deploy/postgres/001-governance.sql ./deploy/postgres/001-governance.sql
ENV APP_UID=1000 APP_ENV=production DOTNET_ENVIRONMENT=Production ASPNETCORE_HTTP_PORTS=9000 \
    MODELLER_APPLICATION_ENABLED=true MODELLER_RESOURCE_ROOT=/app/resources MODEL_REPOSITORY_PATH=/data/models
USER 1000:1000
EXPOSE 9000
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 CMD curl --fail --silent http://127.0.0.1:9000/ready >/dev/null || exit 1
ENTRYPOINT ["dotnet", "Modeller.Mcp.dll"]

FROM runtime AS development
ENV APP_ENV=development DOTNET_ENVIRONMENT=Development

FROM ghcr.io/modelcontextprotocol/inspector:2.0.0@sha256:69bc9110a70afbdd5137af4cbd30636e889b9ce16776f1f3226d1aa8fcd1acb7 AS inspector
USER root
RUN apt-get update && apt-get install -y --no-install-recommends dbus-x11 gnome-keyring libsecret-1-0 \
    && rm -rf /var/lib/apt/lists/*
COPY --chmod=0755 .docker/inspector-entrypoint.sh /usr/local/bin/inspector-entrypoint
USER node
ENTRYPOINT ["/usr/local/bin/inspector-entrypoint"]
CMD ["--web"]

FROM caddy:2-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b AS ingress
RUN setcap -r /usr/bin/caddy
USER 1000:1000

FROM runtime AS fhir-dev
FROM ingress AS fhir-dev-ingress
COPY .docker/Caddyfile /etc/caddy/Caddyfile
FROM runtime AS production
