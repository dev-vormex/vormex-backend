import { prisma } from "../../../../config/prisma";
import { ConfiguredSlot, shiftToIst, getConfiguredReengagementSlots, addDays, getIstStartOfDayUtc, formatDateKey, ReengagementCopy } from "./parse-reengagement-hours.service";

export function getCurrentReengagementWindow(now: Date = new Date()): {
  activityWindowStartUtc: Date | null;
  currentIstHour: number;
  slot: ConfiguredSlot | null;
  slotDateKey: string | null;
} {
  const shifted = shiftToIst(now);
  const currentIstHour = shifted.getUTCHours();
  const slots = getConfiguredReengagementSlots();
  const slot = slots.find((item) => item.hourIst === currentIstHour) || null;

  if (!slot) {
    return {
      activityWindowStartUtc: null,
      currentIstHour,
      slot: null,
      slotDateKey: null,
    };
  }

  const campaignAnchor = slot.isRolloverFinalSlot ? addDays(now, -1) : now;

  return {
    activityWindowStartUtc: getIstStartOfDayUtc(campaignAnchor),
    currentIstHour,
    slot,
    slotDateKey: formatDateKey(campaignAnchor),
  };
}

export async function reserveDelivery(
  userId: string,
  slot: ConfiguredSlot,
  slotDateKey: string,
  copy: ReengagementCopy
) {
  const existing = await prisma.reengagement_notification_deliveries.findUnique({
    where: {
      userId_campaignDateKey_slotKey: {
        campaignDateKey: slotDateKey,
        slotKey: slot.key,
        userId,
      },
    },
  });

  if (existing?.status === 'sent') {
    return null;
  }

  if (existing) {
    return prisma.reengagement_notification_deliveries.update({
      where: { id: existing.id },
      data: {
        body: copy.body,
        campaignType: copy.campaignType,
        payload: copy.data,
        reason: null,
        sentAt: null,
        slotHour: slot.hourIst,
        status: 'pending',
        title: copy.title,
      },
    });
  }

  return prisma.reengagement_notification_deliveries.create({
    data: {
      body: copy.body,
      campaignDateKey: slotDateKey,
      campaignType: copy.campaignType,
      payload: copy.data,
      slotHour: slot.hourIst,
      slotKey: slot.key,
      status: 'pending',
      title: copy.title,
      userId,
    },
  });
}
