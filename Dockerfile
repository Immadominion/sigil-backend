FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json drizzle.config.ts ./
COPY src/ src/
COPY drizzle/ drizzle/
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist dist/
COPY drizzle/ drizzle/
COPY drizzle.config.ts ./
ENV NODE_ENV=production
EXPOSE 3003
CMD ["node", "dist/index.js"]
