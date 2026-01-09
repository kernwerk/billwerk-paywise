import axios from "axios";
import { config } from "../app-config.js";
import { logAxiosError } from "../shared-utils.js";

const billwerk = axios.create({
  baseURL: config.billwerkBaseUrl,
  headers: { "Content-Type": "application/json" },
  timeout: 20000,
});

const billwerkAuth = {
  accessToken: null,
  expiresAt: 0,
  inFlight: null,
};

billwerk.interceptors.request.use(async (request) => {
  const authorization = await getBillwerkAuthorization();
  if (authorization) {
    request.headers.Authorization = authorization;
  }
  return request;
});

billwerk.interceptors.response.use(
  (response) => response,
  (error) => {
    logAxiosError("billwerk", error);
    return Promise.reject(error);
  },
);

async function getBillwerkAuthorization() {
  if (!(config.billwerkClientId && config.billwerkClientSecret)) {
    return null;
  }
  const token = await getBillwerkAccessToken();
  return token ? `Bearer ${token}` : null;
}

async function getBillwerkAccessToken() {
  const now = Date.now();
  if (billwerkAuth.accessToken && now < billwerkAuth.expiresAt) {
    return billwerkAuth.accessToken;
  }
  if (billwerkAuth.inFlight) {
    return billwerkAuth.inFlight;
  }

  billwerkAuth.inFlight = fetchBillwerkAccessToken()
    .then((token) => {
      billwerkAuth.accessToken = token.accessToken;
      billwerkAuth.expiresAt = token.expiresAt;
      return token.accessToken;
    })
    .finally(() => {
      billwerkAuth.inFlight = null;
    });

  return billwerkAuth.inFlight;
}

async function fetchBillwerkAccessToken() {
  const payload = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.billwerkClientId,
    client_secret: config.billwerkClientSecret,
  });

  try {
    const response = await axios.post(
      config.billwerkOauthUrl,
      payload.toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 20000,
      },
    );

    const accessToken = response.data?.access_token;
    if (!accessToken) {
      throw new Error("Missing Billwerk access token");
    }

    const expiresIn = Number(response.data?.expires_in || 0);
    const ttlSeconds = expiresIn > 120 ? expiresIn - 60 : 300;
    const expiresAt = Date.now() + ttlSeconds * 1000;

    return { accessToken, expiresAt };
  } catch (error) {
    const response = error?.response;
    console.error("[billwerk] oauth token request failed", {
      status: response?.status,
      url: config.billwerkOauthUrl,
      data: response?.data,
    });
    throw error;
  }
}

export { billwerk };
