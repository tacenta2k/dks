FROM node:20.19.0-bookworm-slim

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NODE_ENV=development

RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production

EXPOSE 4173

# Containers provide a production renderer preview. The Electron desktop
# process itself is launched by `npm run dev` or the packaged executable.
CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0", "--port", "4173"]
