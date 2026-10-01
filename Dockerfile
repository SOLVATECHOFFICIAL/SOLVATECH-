FROM node:20-bookworm-slim

WORKDIR /app

# Install ffmpeg for WhatsApp sticker and media conversion
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY . .
RUN mkdir -p /app/runtime/sessions /app/runtime/data /app/runtime/logs

ENV NODE_ENV=production
ENV BOT_DATA_DIR=/app/runtime
ENV BOT_API_PREFIX=/bot-api
ENV PORT=3000
ENV FIREBASE_PROJECT_ID=glass-intelligence-253bd
ENV FIREBASE_API_KEY=AIzaSyAmZp-Prdc74empcjYFv9PdFLagiN-to2c
ENV FIREBASE_AUTH_DOMAIN=glass-intelligence-253bd.firebaseapp.com
ENV FIREBASE_DATABASE_ID=ai-studio-remixwhatsappbot-d845e0aa-da32-4907-811f-9be97b2c6851
ENV FIREBASE_STORAGE_BUCKET=glass-intelligence-253bd.firebasestorage.app
ENV FIREBASE_APP_ID=1:91117675798:web:97ae27becca017177a5c37

EXPOSE 3000 8000

CMD ["npm", "start"]