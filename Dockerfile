FROM node:22-bookworm-slim

WORKDIR /app

# Install ffmpeg for WhatsApp sticker and media conversion
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* .npmrc* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --legacy-peer-deps; else npm install --omit=dev --legacy-peer-deps; fi

COPY . .
RUN mkdir -p /app/runtime/sessions /app/runtime/data /app/runtime/logs

ENV NODE_ENV=production
ENV BOT_DATA_DIR=/app/runtime
ENV BOT_API_PREFIX=/bot-api
ENV PORT=3000
ENV ADMIN_EMAIL=awoyinfasolomon1@gmail.com

EXPOSE 3000 8000

CMD ["npm", "start"]