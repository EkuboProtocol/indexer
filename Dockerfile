# syntax=docker/dockerfile:1.6

FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy sources and build once
COPY tsconfig*.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# Remove dev dependencies before shipping
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runner
ENV NODE_ENV=production
ENV NODE_OPTIONS=--enable-source-maps
WORKDIR /app

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY migrations /app/dist/migrations
COPY .env* ./

ENTRYPOINT ["node"]
CMD ["dist/src/index.js"]
