FROM maven:3.9.11-eclipse-temurin-21@sha256:6fdc855a6ed81d288ca7ca37ac6ff5e9308b612485c0801d70b25a858c83d237 AS build
WORKDIR /build/engine
COPY engine/pom.xml ./
COPY engine/src ./src
COPY LICENSE THIRD_PARTY_NOTICES.md /build/
RUN mvn -B -ntp verify

FROM eclipse-temurin:21-jre-alpine@sha256:51ab5e3302e7141ce665ca3ea85e8b5cd648eafbc3c0c90dd79d6537684e4555
RUN addgroup -g 10001 engine && adduser -D -u 10001 -G engine engine
WORKDIR /app
LABEL org.opencontainers.image.authors="Michael Anywar" \
      org.opencontainers.image.vendor="Michael Anywar" \
      org.opencontainers.image.licenses="MIT"
COPY --from=build /build/engine/target/engine-1.2.0.jar ./engine.jar
COPY --from=build /build/engine/target/lib ./lib
COPY --from=build /build/engine/target/bom.json ./sbom.json
COPY LICENSE THIRD_PARTY_NOTICES.md ./
USER 10001:10001
ENTRYPOINT ["java", "-Xmx128m", "-XX:+ExitOnOutOfMemoryError", "-cp", "/app/engine.jar:/app/lib/*", "org.openehr.modelling.engine.Server"]
