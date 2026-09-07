FROM node:20-alpine AS builder

RUN apk update && \
    apk add --no-cache git ffmpeg wget curl bash openssl dos2unix

WORKDIR /evolution

COPY ./package*.json ./
COPY ./tsconfig.json ./
COPY ./tsup.config.ts ./

RUN NODE_OPTIONS="--max-old-space-size=460" npm install --no-audit

COPY ./src ./src
COPY ./public ./public
COPY ./prisma ./prisma
COPY ./manager ./manager
COPY ./.env.example ./.env
COPY ./Docker ./Docker

# البحث عن ملف الـ schema وتوليد Prisma Client مباشرة
RUN SCHEMA_FILE=$(find ./prisma -name "*.prisma" | head -n 1) && \
    echo "Using schema: $SCHEMA_FILE" && \
    npx prisma generate --schema="$SCHEMA_FILE"

# بناء المشروع CJS
RUN npx tsup src/main.ts --format cjs --target node20 --no-splitting --clean

FROM node:20-alpine AS final

RUN apk update && \
    apk add --no-cache tzdata ffmpeg bash openssl

WORKDIR /evolution

COPY --from=builder /evolution/package.json ./package.json
COPY --from=builder /evolution/package-lock.json ./package-lock.json
COPY --from=builder /evolution/node_modules ./node_modules
COPY --from=builder /evolution/dist ./dist
COPY --from=builder /evolution/prisma ./prisma
COPY --from=builder /evolution/manager ./manager
COPY --from=builder /evolution/public ./public
COPY --from=builder /evolution/.env ./.env
COPY --from=builder /evolution/Docker ./Docker

ENV DOCKER_ENV=true
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/main.js"]
