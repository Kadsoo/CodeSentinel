FROM node:22.17.0-alpine AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json vite.config.ts eslint.config.mjs ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tests ./tests
COPY SPEC.md PLAN.md SPEC_PROCESS.md AGENT_LOG.md README.md REFLECTION.md ./

RUN npm ci --ignore-scripts --no-audit --no-fund
RUN npm --workspace @kadsoo/codesentinel-web run build

FROM nginx:1.27-alpine

COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
