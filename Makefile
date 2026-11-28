.DEFAULT_GOAL := help
SDK_IMAGE := mcr.microsoft.com/dotnet/sdk:10.0.404@sha256:8c6edfb26c85153f236d26efebd9ad349aec403583f343f201ee67838b23658d
SDK := docker run --rm -v "$(CURDIR):/repo" -v "$${MODELLER_NUGET_CACHE:-/tmp/modeller-dotnet-nuget}:/root/.nuget/packages" -w /repo/dotnet $(SDK_IMAGE)
COMPOSE := docker compose -f docker-compose.yml
DEV := $(COMPOSE) -f .docker/docker-compose.dev.yml
.PHONY: help env install compile unit spec-check ci browser build up up-dev down logs ps run-stdio conformance
help: ## Show development commands
	@awk 'BEGIN {FS=":.*##"} /^[a-z-]+:.*##/ {printf "%-15s %s\n",$$1,$$2}' $(MAKEFILE_LIST)
env: ## Create local installer defaults without overwriting existing settings
	@test -f .env || cp .env.example .env
install: ## Restore locked .NET dependencies; install browser test dependencies
	$(SDK) dotnet restore Modeller.Mcp --locked-mode -p:NuGetAudit=false
	$(SDK) dotnet restore Modeller.Processing --locked-mode -p:NuGetAudit=false
	$(SDK) dotnet restore Modeller.Extraction --locked-mode -p:NuGetAudit=false
	$(SDK) dotnet restore Modeller.Kafka --locked-mode -p:NuGetAudit=false
	npm ci --prefix chat --ignore-scripts --no-audit
compile: ## Compile application and private worker in the pinned SDK container
	$(SDK) dotnet build Modeller.Mcp -c Release --no-restore
	$(SDK) dotnet build Modeller.Processing -c Release --no-restore
	$(SDK) dotnet build Modeller.Extraction -c Release --no-restore
	$(SDK) dotnet build Modeller.Kafka -c Release --no-restore
unit: ## Verify application, mapping/delivery and source-plan behaviour on synthetic data
	$(SDK) dotnet run --project Modeller.Application.Tests -c Release -p:NuGetAudit=false
	$(SDK) dotnet run --project Modeller.Processing.Tests -c Release -p:NuGetAudit=false
	$(SDK) dotnet run --project Modeller.Database.Tests -c Release -p:NuGetAudit=false
	$(SDK) dotnet run --project Modeller.Vendor.Tests -c Release -p:NuGetAudit=false
	$(SDK) dotnet run --project Modeller.Operational.Tests -c Release -p:NuGetAudit=false
spec-check: ## Verify requirement and implementation traceability
	python3 scripts/spec-check.py
browser: ## Run browser-backend checks using Node 22
	npm --prefix chat test
ci: spec-check compile unit browser ## Run local functional checks without building application images
build: ## Request application image validation on hosted CI
	gh workflow run dotnet-migration.yml --ref "$$(git branch --show-current)"
up: ## Start prebuilt images and preserve existing volumes
	$(COMPOSE) up -d --no-build
up-dev: ## Start prebuilt development images and preserve existing volumes
	$(DEV) up -d --no-build
down: ## Stop services while retaining volumes
	$(COMPOSE) down
logs: ## Follow service logs
	$(COMPOSE) logs -f
ps: ## Show service state
	$(COMPOSE) ps
run-stdio: ## Run the installed application MCP over standard input/output
	$(COMPOSE) run --rm -T --no-deps app --stdio
conformance: ## Check HTTP/stdio contracts with synthetic fixtures and the pinned SDK
	python3 dotnet/tests/run-contracts.py --sdk-image $(SDK_IMAGE)
