FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY prisma ./prisma
COPY scripts ./scripts
COPY src ./src
COPY tsconfig.json ./
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY prisma ./prisma
COPY --from=build /app/dist ./dist

FROM runtime AS api
CMD ["node", "dist/api.js"]

FROM runtime AS worker
CMD ["node", "dist/worker.js"]

FROM runtime AS scheduler
CMD ["node", "dist/scheduler.js"]
