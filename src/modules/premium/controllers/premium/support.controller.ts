
import { Request } from "express";
import { isRazorpayConfigured } from "../../services/premium-razorpay.service";
import { isGooglePlayPremiumConfigured } from "../../services/google-play-premium.service";
import axios from "axios";

export type { AuthenticatedRequest as AuthRequest } from "../../../../shared/types/authenticated-request";

export type WebhookRequest = Request & { rawBody?: Buffer };

export type RazorpayWebhookPayload = {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string } };
    order?: { entity?: { id?: string } };
  };
};

export function isPremiumCheckoutConfigured() {
  return isRazorpayConfigured() || isGooglePlayPremiumConfigured();
}

export function getRazorpayResponseError(error: unknown) {
  if (!axios.isAxiosError(error)) {
    return null;
  }

  const responseError =
    error.response?.data &&
    typeof error.response.data === 'object' &&
    'error' in error.response.data
      ? (error.response.data as { error?: unknown }).error
      : null;

  if (!responseError || typeof responseError !== 'object') {
    return null;
  }

  return responseError as {
    code?: unknown;
    description?: unknown;
    reason?: unknown;
    source?: unknown;
    step?: unknown;
  };
}
