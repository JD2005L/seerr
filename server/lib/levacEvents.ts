// Levac fork: events for PVIBot (Hermes on CT321) besides Notify PVIBot.
// Sent, signed like Notify PVIBot, to the n8n relay named by eventsUrl in
// config/levac-notify.json; n8n picks the Hermes webhook route by event_type.
// No eventsUrl (tests, other installs) = nothing is sent.
import { hermesEnvelope, notifyConfig } from '@server/lib/fanout';
import logger from '@server/logger';
import axios from 'axios';

export type LevacEventType = 'seerr_issue' | 'seerr_user_setup';

export type LevacEvent = {
  event_type: LevacEventType;
  [field: string]: string | number | null;
};

export type LevacEventResult = { sent: boolean; error?: string };

export const levacEventSender = {
  post: (url: string, body: unknown, key: string) =>
    axios.post(url, body, {
      headers: { 'X-Seerr-Key': key },
      timeout: 20000,
    }),
};

/**
 * Hermes fills its prompt from the top-level fields, so keep them flat
 * strings or numbers. deliveryId must be unique per event: Hermes drops a
 * repeated one.
 */
export async function sendLevacEvent(
  event: LevacEvent,
  deliveryId: string
): Promise<LevacEventResult> {
  const config = notifyConfig();
  if (!config?.eventsUrl) return { sent: false, error: 'not set up' };
  try {
    await levacEventSender.post(
      config.eventsUrl,
      {
        ...event,
        hermes: hermesEnvelope(event, config.hermesSecret, deliveryId),
      },
      config.key
    );
    return { sent: true };
  } catch (e) {
    logger.warn(`Could not send ${event.event_type} to PVIBot: ${e.message}`, {
      label: 'Levac Events',
      deliveryId,
    });
    return { sent: false, error: e.message };
  }
}
