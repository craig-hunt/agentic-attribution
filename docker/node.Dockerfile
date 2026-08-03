# Node 24 carries the current LTS line. The npm that ships inside the image
# trails the registry, and its update notice prints on every build, so the
# notifier gets turned off rather than left to suggest a global install nobody
# should run inside an image.
FROM node:24-alpine
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

# Workspace manifests first so a source edit does not invalidate the install
# layer. npm needs every workspace package.json present to resolve the tree.
COPY package.json package-lock.json ./
COPY packages/types/package.json ./packages/types/
COPY gateway/package.json ./gateway/
COPY merchant/package.json ./merchant/
COPY facilitator/package.json ./facilitator/
COPY simulator/package.json ./simulator/

RUN npm ci

COPY tsconfig.base.json ./
COPY packages ./packages
COPY gateway ./gateway
COPY merchant ./merchant
COPY facilitator ./facilitator
COPY simulator ./simulator

RUN npm run build --workspace @agentic-attribution/types

# Stryker needs the Go-minted fixture and the migration files the tests read by
# relative path, so the test stage carries them.
FROM node:24-alpine AS test
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app
COPY --from=0 /app ./
COPY db ./db

CMD ["npm", "test", "--workspaces", "--if-present"]

FROM node:24-alpine AS runtime
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app
COPY --from=0 /app ./

USER node
