// Import with `import * as Sentry from "@sentry/node"` if you are using ESM
const Sentry = require("@sentry/node");

Sentry.init({
  dsn: "https://46765ae2b76829fad01cec49e0da9643@o4509669806833664.ingest.us.sentry.io/4509669807095808",

  // Setting this option to true will send default PII data to Sentry.
  // For example, automatic IP address collection on events
  sendDefaultPii: true,
});

try {
  foo();
} catch (e) {
  Sentry.captureException(e);
}
