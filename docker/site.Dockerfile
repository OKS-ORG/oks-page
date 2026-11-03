# The minimal site as one image (S8): the site, the database driver, the admin and oks-ui. SQLite lives in /data.
# This is the baseline that the memory and start-time measurements run on (scripts/hosting-baseline.sh).
FROM node:22-slim AS build
# better-sqlite3 is built from source here, which needs Python and a C++ compiler.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
# The pages read the database only when asked, so the build needs none.
RUN OKS_SQLITE_PATH=/nonexistent pnpm --filter @oks-page/site build

FROM node:22-slim
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production \
    PORT=3000 \
    OKS_SQLITE_PATH=/data/site.sqlite
VOLUME /data
EXPOSE 3000
WORKDIR /app/apps/site
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000", "-H", "0.0.0.0"]
