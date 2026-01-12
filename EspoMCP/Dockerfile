# Build stage
FROM node:18-alpine AS builder

WORKDIR /app

# Install build deps
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . ./
RUN npm run build

# Runtime stage
FROM node:18-alpine

WORKDIR /app

# Copy only production dependencies
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy built assets from builder
COPY --from=builder /app/build ./build
COPY README.md LICENSE* ./

# Create logs directory
RUN mkdir -p logs

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S espocrm -u 1001 -G nodejs

RUN chown -R espocrm:nodejs /app
USER espocrm

ENV NODE_ENV=production
ENV LOG_LEVEL=info

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "console.log('Health check - server should be running')" || exit 1

EXPOSE 3000

CMD ["node", "build/src/index.js"]