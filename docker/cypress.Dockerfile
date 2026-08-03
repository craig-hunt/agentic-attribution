# The Cypress image already carries the browser and the Cypress binary, which
# is most of the download. Reinstalling it through npm would fetch several
# hundred megabytes a second time, so CYPRESS_INSTALL_BINARY turns that off and
# the image's own binary gets used.
FROM cypress/included:14.5.4

WORKDIR /suite

ENV CYPRESS_INSTALL_BINARY=0
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

# Manifests first, so editing a spec does not invalidate the install layer.
COPY cypress-tests/package.json cypress-tests/package-lock.json ./

RUN npm ci

COPY cypress-tests/cypress.config.ts ./
COPY cypress-tests/cypress ./cypress

# The base image sets an entrypoint that runs Cypress directly. Overriding it
# lets compose pass a plain command and keeps `docker compose run` behaving the
# way every other service in this stack does.
ENTRYPOINT []

CMD ["npx", "cypress", "run"]
