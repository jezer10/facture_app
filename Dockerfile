# syntax=docker/dockerfile:1.7

FROM node:24.14.1-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN pnpm build

FROM base AS runtime-dependencies
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-prod,target=/pnpm/store pnpm install --prod --frozen-lockfile --ignore-scripts

FROM runtime-dependencies AS runtime
COPY --from=build /app/dist ./dist
USER node

FROM runtime-dependencies AS runtime-worker
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN pnpm exec playwright install --with-deps --only-shell chromium
COPY --from=build /app/dist ./dist
USER node

FROM dependencies AS migrations
COPY . .
CMD ["pnpm", "migration:run:all"]
