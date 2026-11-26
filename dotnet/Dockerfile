FROM mcr.microsoft.com/dotnet/sdk:10.0.404@sha256:8c6edfb26c85153f236d26efebd9ad349aec403583f343f201ee67838b23658d AS build
WORKDIR /src
COPY dotnet/global.json dotnet/global.json
COPY dotnet/Modeller.Core/Modeller.Core.csproj dotnet/Modeller.Core/
COPY dotnet/Modeller.Mcp/Modeller.Mcp.csproj dotnet/Modeller.Mcp/packages.lock.json dotnet/Modeller.Mcp/
WORKDIR /src/dotnet/Modeller.Mcp
RUN dotnet restore --locked-mode
COPY dotnet/ /src/dotnet/
RUN dotnet publish -c Release --no-restore -o /out -p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0.15@sha256:aac50ceef10391e78a899e3d2ccd00bbafa2dcb56ccf4586cbccf00edb84fc21
WORKDIR /app
COPY --from=build /out/ ./
COPY resources/guides/ /app/resources/guides/
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY dotnet/notices/ /app/notices/
ENV DOTNET_ENVIRONMENT=Production ASPNETCORE_HTTP_PORTS=8080 GUIDE_ROOT=/app/resources/guides
USER $APP_UID
EXPOSE 8080
ENTRYPOINT ["dotnet", "Modeller.Mcp.dll"]
