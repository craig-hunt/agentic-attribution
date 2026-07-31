FROM node:22-alpine

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

USER node
