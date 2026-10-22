import type { QuietHours } from './schedule';
import type { EventCampaignRow } from './types';
import type { EventContext } from './variables';

/** Client-safe helpers (no server imports) shared by the UI and the server code. */
export function quietOf(c: Pick<EventCampaignRow, 'quiet_enabled' | 'quiet_from' | 'quiet_to'>): QuietHours {
  return { enabled: c.quiet_enabled, from: c.quiet_from, to: c.quiet_to };
}

export function eventContextOf(c: EventCampaignRow): EventContext {
  return {
    name: c.name,
    eventAt: new Date(c.event_at),
    joinLink: c.join_link,
    location: c.location,
  };
}