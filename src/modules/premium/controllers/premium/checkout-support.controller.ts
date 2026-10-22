import { isThirdPartyHttpError } from "../../../../infrastructure/http/http-client-with-breaker.util";
import axios from "axios";
import { getRazorpayResponseError } from "./support.controller";

export type SafeRazorpayError = {
  statusCode: number;
  clientMessage: string;
  code: string;
  logMessage: string;
  metadata: { [key: string]: string | number | null };
};

export function getSafeRazorpayError(error: unknown): SafeRazorpayError {
  if (isThirdPartyHttpError(error)) {
    return {
      statusCode: 503,
      clientMessage:
        error.code === 'third_party_circuit_open'
          ? 'Razorpay checkout is temporarily unavailable. Please try again shortly.'
          : 'Could not reach Razorpay checkout. Please try again shortly.',
      code:
        error.code === 'third_party_circuit_open'
          ? 'razorpay_circuit_open'
          : 'razorpay_timeout',
      logMessage: error.message,
      metadata: {
        provider: error.provider,
        operation: error.operation,
        retryable: error.retryable ? 1 : 0,
      },
    };
  }

  if (!axios.isAxiosError(error)) {
    return {
      statusCode: 500,
      clientMessage: 'Failed to create premium checkout',
      code: 'premium_checkout_failed',
      logMessage: error instanceof Error ? error.message : 'Unknown checkout error',
      metadata: {},
    };
  }

  const providerError = getRazorpayResponseError(error);
  const providerCode =
    typeof providerError?.code === 'string' ? providerError.code : undefined;
  const providerReason =
    typeof providerError?.reason === 'string' ? providerError.reason : undefined;
  const providerDescription =
    typeof providerError?.description === 'string'
      ? providerError.description
      : undefined;
  const providerSource =
    typeof providerError?.source === 'string' ? providerError.source : undefined;
  const providerStep =
    typeof providerError?.step === 'string' ? providerError.step : undefined;
  const providerStatus = error.response?.status;
  const metadata = {
    provider: 'razorpay',
    providerStatus: providerStatus ?? null,
    providerCode: providerCode ?? null,
    providerReason: providerReason ?? null,
    providerSource: providerSource ?? null,
    providerStep: providerStep ?? null,
    axiosCode: error.code ?? null,
  };

  if (providerStatus === 401) {
    return {
      statusCode: 503,
      clientMessage:
        'Premium checkout is not configured correctly on the server. Please check Razorpay credentials and restart the backend.',
      code: 'razorpay_auth_failed',
      logMessage: 'Razorpay rejected the configured checkout credentials.',
      metadata,
    };
  }

  if (providerStatus === 400) {
    return {
      statusCode: 502,
      clientMessage:
        providerDescription || 'Razorpay rejected the premium checkout request.',
      code: 'razorpay_checkout_rejected',
      logMessage: providerDescription || 'Razorpay rejected the checkout request.',
      metadata,
    };
  }

  if (providerStatus === 429) {
    return {
      statusCode: 503,
      clientMessage: 'Razorpay is rate-limiting checkout right now. Please try again shortly.',
      code: 'razorpay_rate_limited',
      logMessage: 'Razorpay rate-limited premium checkout creation.',
      metadata,
    };
  }

  if (!error.response) {
    return {
      statusCode: 503,
      clientMessage: 'Could not reach Razorpay checkout. Please try again shortly.',
      code: 'razorpay_unreachable',
      logMessage: error.message || 'Razorpay checkout request failed without a response.',
      metadata,
    };
  }

  return {
    statusCode: 502,
    clientMessage: 'Razorpay checkout is temporarily unavailable. Please try again shortly.',
    code: 'razorpay_checkout_failed',
    logMessage: providerDescription || `Razorpay checkout failed with status ${providerStatus}.`,
    metadata,
  };
}
