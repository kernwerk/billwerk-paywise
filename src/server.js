import express from "express";
import { config } from "./app-config.js";
import { handlePaymentEscalated } from "./handlers/payment-escalated-handler.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/webhooks/billwerk/payment-escalated", handlePaymentEscalated);

app.listen(config.port, () => {
  console.log(`Webhook listener running on port ${config.port}`);
});
