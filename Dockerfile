FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server.ts firebase-applet-config.json ./
COPY src/utils ./src/utils
USER node
# Cloud Run injects PORT; the server binds 0.0.0.0:$PORT.
CMD ["node", "server.ts"]
