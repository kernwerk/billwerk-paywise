import axios from "axios";
import { config } from "../app-config.js";
import { logAxiosError } from "../shared-utils.js";

const paywise = axios.create({
  baseURL: config.paywiseBaseUrl,
  headers: {
    Authorization: config.paywiseToken
      ? `Bearer ${config.paywiseToken}`
      : undefined,
    "Content-Type": "application/json",
  },
  timeout: 20000,
});

paywise.interceptors.response.use(
  (response) => response,
  (error) => {
    logAxiosError("paywise", error);
    return Promise.reject(error);
  },
);

export { paywise };
