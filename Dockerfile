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
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY supabase ./supabase
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p /data/workspace /data/tmp

EXPOSE 3000
CMD ["node", "server/index.ts"]
