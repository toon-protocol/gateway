# The Workload Gateway as a container. The TOON sandbox (infra/sandbox, its
# `gateway` profile) builds it from this checkout; a deployment can too. One
# `docker build .` at the repo root, in the directory publisher's style.
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src/ src/

# Configuration is environment only (README "Configuration"); the certificate
# pair, when there is one, is mounted wherever GATEWAY_TLS_CERT/KEY point.
ENV NODE_ENV=production
# 8080/8443 front workloads; 8081 is where the connector forwards a sealed
# Gateway Handover (GATEWAY_HANDOVER_PORT, README "Configuration").
EXPOSE 8080 8081 8443

CMD ["node", "src/main.mjs"]
