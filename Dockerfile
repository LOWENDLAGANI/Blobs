# Build the React control centre, then run the server on Node 24, which can
# execute the TypeScript sources directly (no compile step for the backend).
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY web ./web
RUN npm run build

FROM node:24-alpine AS runtime
# Port 80 is what Vercel routes container traffic to by default; every other
# host should pass PORT explicitly (docker-compose and render.yaml do).
ENV NODE_ENV=production \
    PORT=80 \
    HOST=0.0.0.0 \
    DATA_DIR=/data
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY supabase ./supabase
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p /data/workspace /data/tmp

EXPOSE 80 3000
# The Vercel scheduler daemon uses this same image with
# `command: ["node", "server/worker.ts"]` (see vercel.json).
CMD ["node", "server/index.ts"]
