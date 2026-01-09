import axios from "axios";
import { config } from "../app-config.js";
import { logAxiosError } from "../shared-utils.js";

const letterxpress = axios.create({
  baseURL: config.letterxpressBaseUrl,
  headers: { "Content-Type": "application/json" },
  timeout: 20000,
});

letterxpress.interceptors.response.use(
  (response) => response,
  (error) => {
    logAxiosError("letterxpress", error);
    return Promise.reject(error);
  },
);

export { letterxpress };
