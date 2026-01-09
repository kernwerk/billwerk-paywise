import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { handlePaymentEscalated } from "./handlers/payment-escalated-handler.js";

const app = new Hono();

app.use("*", bodyLimit({ maxSize: 1024 * 1024 }));

app.get("/health", (c) => c.json({ status: "ok" }));

app.post("/webhooks/billwerk/payment-escalated", handlePaymentEscalated);

export default app;
