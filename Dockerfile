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
ENV PORT=8000
ENV FIREBASE_PROJECT_ID=gen-lang-client-0324946831
ENV FIREBASE_API_KEY=AIzaSyA_g2ek4ziXSE9m4VD5-5PfKpKJjAobYFg
ENV FIREBASE_AUTH_DOMAIN=gen-lang-client-0324946831.firebaseapp.com
ENV FIREBASE_DATABASE_ID=ai-studio-whatsappbot-da9a52de-41e7-4365-a5b4-8aec9332642c
ENV FIREBASE_STORAGE_BUCKET=gen-lang-client-0324946831.firebasestorage.app
ENV FIREBASE_APP_ID=1:420914651308:web:ae4cb5d7632401c1a83f09

EXPOSE 3000

CMD ["npm", "start"]