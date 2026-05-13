FROM node:20-bookworm-slim

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
COPY daemon/package.json ./daemon/package.json

RUN mkdir -p /etc/magclaw /var/lib/magclaw/uploads

EXPOSE 6543

CMD ["node", "server/index.js"]
