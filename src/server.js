import { serve } from "@hono/node-server";
import { config } from "./app-config.js";
import app from "./app.js";

serve({ fetch: app.fetch, port: config.port });
console.log(`Webhook listener running on port ${config.port}`);
