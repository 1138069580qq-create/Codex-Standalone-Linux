FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git iproute2 ca-certificates
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY public ./public
COPY scripts/user.ts ./scripts/user.ts
COPY LICENSE NOTICE ./
ENV NODE_ENV=production CODEX_WEBUI_HOST=0.0.0.0 CODEX_WEBUI_PORT=3210 CODEX_WEBUI_DATA=/data
USER node
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3210/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
