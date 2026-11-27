FROM mcr.microsoft.com/dotnet/sdk:10.0.404@sha256:8c6edfb26c85153f236d26efebd9ad349aec403583f343f201ee67838b23658d AS build
WORKDIR /src
COPY dotnet/global.json dotnet/global.json
COPY dotnet/Modeller.Core/Modeller.Core.csproj dotnet/Modeller.Core/packages.lock.json dotnet/Modeller.Core/
COPY dotnet/Modeller.Operational/Modeller.Operational.csproj dotnet/Modeller.Operational/packages.lock.json dotnet/Modeller.Operational/
COPY dotnet/Modeller.Database/Modeller.Database.csproj dotnet/Modeller.Database/packages.lock.json dotnet/Modeller.Database/
COPY dotnet/Modeller.Application/Modeller.Application.csproj dotnet/Modeller.Application/packages.lock.json dotnet/Modeller.Application/
COPY dotnet/Modeller.Mcp/Modeller.Mcp.csproj dotnet/Modeller.Mcp/packages.lock.json dotnet/Modeller.Mcp/
WORKDIR /src/dotnet/Modeller.Mcp
RUN dotnet restore --locked-mode -p:NuGetAudit=false
COPY dotnet/ /src/dotnet/
COPY deploy/postgres/001-governance.sql /src/deploy/postgres/001-governance.sql

RUN dotnet publish -c Release --no-restore -o /out -p:UseAppHost=false

RUN sh /src/dotnet/notices/collect-notices.sh /root/.nuget/packages /out/notices/nuget

FROM mcr.microsoft.com/dotnet/aspnet:10.0.15@sha256:aac50ceef10391e78a899e3d2ccd00bbafa2dcb56ccf4586cbccf00edb84fc21
WORKDIR /app
COPY --from=build /out/ ./
COPY resources/ /app/resources/
COPY VERSION /app/VERSION
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY dotnet/notices/ /app/notices/
ENV DOTNET_ENVIRONMENT=Production ASPNETCORE_HTTP_PORTS=8080 GUIDE_ROOT=/app/resources/guides
USER $APP_UID
EXPOSE 8080
ENTRYPOINT ["dotnet", "Modeller.Mcp.dll"]
