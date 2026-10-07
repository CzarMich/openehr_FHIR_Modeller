FROM node:22.22.1-bookworm-slim AS dependencies
WORKDIR /opt/fhir
COPY fhir/package.json fhir/package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund

FROM eclipse-temurin:21-jre-jammy AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/fhir/tools && \
    curl --connect-timeout 20 --max-time 600 --retry 3 -fL https://github.com/hapifhir/org.hl7.fhir.core/releases/download/6.10.4/validator_cli.jar -o /opt/fhir/tools/validator_cli.jar && \
    echo '1106b9d58f9e363e47bea7c4fc065841e5fc91fe9d062775c3bfdd212bd653cc  /opt/fhir/tools/validator_cli.jar' | sha256sum -c -

FROM eclipse-temurin:21-jdk-jammy AS validation-runner
COPY --from=runtime /opt/fhir/tools/validator_cli.jar /tools/validator_cli.jar
COPY fhir/java/ValidationRunner.java /src/ValidationRunner.java
RUN javac --release 21 -proc:none -cp /tools/validator_cli.jar -d /tools /src/ValidationRunner.java

FROM runtime
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
WORKDIR /opt/fhir
COPY --from=dependencies /opt/fhir/node_modules ./node_modules
COPY --from=validation-runner /tools/ValidationRunner.class ./tools/ValidationRunner.class
COPY fhir/ ./
RUN mkdir -p /data/fhir && \
    useradd --uid 10001 --create-home fhir && chown -R fhir:fhir /data/fhir
ENV NODE_ENV=production FHIR_DATA_DIR=/data/fhir FHIR_VALIDATOR_JAR=/opt/fhir/tools/validator_cli.jar PORT=8094
USER fhir
EXPOSE 8094
HEALTHCHECK --interval=30s --timeout=5s CMD ["node","-e","fetch('http://127.0.0.1:8094/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node","server.mjs"]
