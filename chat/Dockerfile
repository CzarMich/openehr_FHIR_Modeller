FROM node:22.22.1-bookworm-slim AS dependencies
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/chat
COPY chat/package.json chat/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
RUN mkdir -p /data/chat /workspace && chown -R node:node /data/chat /workspace
ENV CHAT_PORT=8350
EXPOSE 8350
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:8350/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "entrypoint.mjs"]

# Opt in to the provider adapter only when conversational chat is enabled.
FROM dependencies AS chat
LABEL org.opencontainers.image.authors="Michael Anywar" \
      org.opencontainers.image.vendor="Michael Anywar" \
      org.opencontainers.image.licenses="MIT"
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --ignore-scripts @openai/codex@0.157.1
COPY chat/src ./src
COPY chat/entrypoint.mjs ./entrypoint.mjs
COPY public/chat /app/public/chat
COPY LICENSE THIRD_PARTY_NOTICES.md /app/
USER node

# Default browser workspace supports human review without a model-provider runtime.
FROM dependencies AS reviews
LABEL org.opencontainers.image.authors="Michael Anywar" \
      org.opencontainers.image.vendor="Michael Anywar" \
      org.opencontainers.image.licenses="MIT"
COPY chat/src ./src
COPY chat/entrypoint.mjs ./entrypoint.mjs
COPY public/chat /app/public/chat
COPY LICENSE THIRD_PARTY_NOTICES.md /app/
USER node
