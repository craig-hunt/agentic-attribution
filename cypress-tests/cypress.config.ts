import { defineConfig } from 'cypress';
import * as dotenv from 'dotenv';

// The demo runs on one machine and publishes fixed ports, so the suite works
// immediately after a clone with no .env present, which the standards require
// to stay outside the project directory. See README standard 6.
//
// Two sets of defaults. Running on the host reaches the published ports on
// localhost; running inside the compose network reaches services by name, and
// `make e2e` supplies those through the shell environment.
const DefaultEnv = {
  CYPRESS_DASHBOARD_BASE_URL: 'http://localhost:8000',
  CYPRESS_GATEWAY_BASE_URL: 'http://localhost:8080',
  CYPRESS_SETTLEMENT_BASE_URL: 'http://localhost:8082',
} as const;

const OverridableKeys = Object.keys(DefaultEnv);

// CYPRESS_DOTENV_PATH points at a .env stored outside the repository. Absent
// that variable, no file is read and the defaults above apply.
const dotenvPath = process.env.CYPRESS_DOTENV_PATH;
const fileEnv = dotenvPath ? (dotenv.config({ path: dotenvPath }).parsed ?? {}) : {};

// Shell environment wins over the file, which wins over the defaults.
const shellEnv = Object.fromEntries(
  OverridableKeys.filter((key) => process.env[key]).map((key) => [key, process.env[key] as string])
);

export default defineConfig({
  e2e: {
    specPattern: 'cypress/support/test_cases/**/*.ts',
    supportFile: 'cypress/support/e2e.ts',
    env: { ...DefaultEnv, ...fileEnv, ...shellEnv },
    // A live population keeps writing while a spec runs, so the retry that
    // matters is Cypress re-querying the DOM rather than re-running the test.
    // Test-level retries stay off: a spec that passes on the second attempt
    // hides a race rather than tolerating one.
    retries: { runMode: 0, openMode: 0 },
    video: false,
    screenshotOnRunFailure: true,
    // Seeding leaves the cluster warm but the first neural query still costs
    // more than a steady-state one, and the suite asserts a latency budget
    // rather than inheriting a default that would mask a regression.
    defaultCommandTimeout: 10_000,
    requestTimeout: 15_000,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    setupNodeEvents(on, config) {
      // Register node event listeners and plugins here. The `on` parameter
      // attaches event handlers; `config` exposes the resolved configuration
      // for runtime modification. Both stay unused until the first plugin
      // lands, so the disable directive above suppresses no-unused-vars.
      // Delete that directive once code consumes either parameter.
    },
  },
});
