FROM node:20-alpine AS builder

RUN apk update && \
    apk add --no-cache git ffmpeg wget curl bash openssl

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

# اعتماد سكيما MySQL وتوليد Prisma Client
RUN cp ./prisma/mysql-schema.prisma ./prisma/schema.prisma && \
    npx prisma generate --schema=./prisma/schema.prisma

# بناء المشروع CJS
RUN npx tsup src/main.ts --format cjs --target node20 --no-splitting --clean

FROM node:20-alpine AS final

# تثبيت mariadb محلياً داخل الحاوية لإنشاء قاعدة بيانات مدمجة
RUN apk update && \
    apk add --no-cache tzdata ffmpeg bash openssl mariadb mariadb-client

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

# تهيئة مجلد MariaDB
RUN mkdir -p /run/mysqld && chown -R mysql:mysql /run/mysqld /var/lib/mysql

ENV DOCKER_ENV=true
ENV PORT=8080
EXPOSE 8080

# بدء تشغيل سيرفر MySQL محلياً وإنشاء القاعدة ثم إطلاق السيرفر
CMD ["sh", "-c", "mysql_install_db --user=mysql --datadir=/var/lib/mysql > /dev/null 2>&1 && mysqld --user=mysql --datadir=/var/lib/mysql & until mysqladmin ping --silent; do sleep 1; done && mysql -e 'CREATE DATABASE IF NOT EXISTS evolution;' && npx prisma db push --schema=./prisma/schema.prisma --accept-data-loss --skip-generate || true; node dist/main.js"]
