# syntax=docker/dockerfile:1.6

FROM oven/bun:1.3 AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NODE_OPTIONS=--enable-source-maps

# Install only production dependencies
COPY package*.json ./
RUN bun ci --omit=dev

# Copy source files that Bun can execute directly
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY .env* ./

RUN chmod +x scripts/restart.sh

ENTRYPOINT ["/app/scripts/restart.sh"]
CMD ["bun", "src/index.ts"]
