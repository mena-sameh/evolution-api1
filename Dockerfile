FROM node:20-alpine AS builder

RUN apk update && \
    apk add --no-cache git ffmpeg wget curl bash openssl

WORKDIR /evolution

COPY ./package*.json ./
COPY ./tsconfig.json ./
COPY ./tsup.config.ts ./

# تثبيت الاعتماديات (بما فيها TypeScript وأدوات البناء) مع ضبط حد الذاكرة
RUN NODE_OPTIONS="--max-old-space-size=460" npm install --no-audit

# نسخ بقية الملفات اللازمة لعملية البناء
COPY ./src ./src
COPY ./public ./public
COPY ./prisma ./prisma
COPY ./manager ./manager
COPY ./.env.example ./.env

# تشغيل البناء بعد توفر الملفات وأداة tsc
RUN npx tsup
FROM node:20-alpine AS final

RUN apk update && \
    apk add tzdata ffmpeg bash openssl

WORKDIR /evolution

COPY --from=builder /evolution/package.json ./package.json
COPY --from=builder /evolution/package-lock.json ./package-lock.json
COPY --from=builder /evolution/node_modules ./node_modules
COPY --from=builder /evolution/dist ./dist
COPY --from=builder /evolution/prisma ./prisma
COPY --from=builder /evolution/manager ./manager
COPY --from=builder /evolution/public ./public
COPY --from=builder /evolution/.env ./.env

ENV DOCKER_ENV=true
EXPOSE 8080

CMD ["sh", "-c", "cp /evolution/node_modules/@figuro/chatwoot-sdk/dist/core/request.js /evolution/node_modules/@figuro/chatwoot-sdk/dist/core/request 2>/dev/null || true; node dist/main.mjs"]
