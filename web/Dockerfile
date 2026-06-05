FROM node:20-bookworm-slim AS assets

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY public ./public
COPY scripts ./scripts

RUN npm run build:web-assets

FROM node:20-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV MAGCLAW_DATA_DIR=/var/lib/magclaw
ENV MAGCLAW_UPLOAD_DIR=/var/lib/magclaw/uploads

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public
COPY shared ./shared
COPY scripts ./scripts
COPY daemon/package.json ./daemon/package.json
COPY team-sharing ./team-sharing
COPY --from=assets /app/public/.magclaw-assets ./public/.magclaw-assets

RUN mkdir -p /etc/magclaw /var/lib/magclaw/uploads

EXPOSE 6543

CMD ["node", "server/index.js"]
