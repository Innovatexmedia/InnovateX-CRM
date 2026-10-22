import type { EventCampaignRow, EventReminderRow } from '@/lib/events/types';

export const CAMPAIGN_STATUS_STYLE: Record<EventCampaignRow['status'], string> = {
  active: 'bg-emerald-500/10 text-emerald-400',
  paused: 'bg-amber-500/10 text-amber-400',
  cancelled: 'bg-red-500/10 text-red-400',
  completed: 'bg-blue-500/10 text-blue-400',
};

export const REMINDER_STATUS_STYLE: Record<EventReminderRow['status'], string> = {
  scheduled: 'bg-violet-500/10 text-violet-400',
  processing: 'bg-amber-500/10 text-amber-400',
  queued: 'bg-emerald-500/10 text-emerald-400',
  skipped: 'bg-muted text-muted-foreground',
  failed: 'bg-red-500/10 text-red-400',
};