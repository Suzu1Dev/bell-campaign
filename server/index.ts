import { join } from "node:path";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { CampaignStore } from "./store.js";

const config = loadConfig();
const store = new CampaignStore(
  join(config.dataDir, "bell-campaign.sqlite"),
  join(config.dataDir, "uploads"),
);

const app = createApp({
  store,
  allowedOrigins: config.allowedOrigins,
  suiteLinks: config.suiteLinks,
});

const server = app.listen(config.port, config.host, () => {
  if (process.env.BELL_LOG !== "off") {
    console.log(`BELL Campaign listening on http://${config.host}:${config.port}`);
  }
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
