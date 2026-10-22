import type { EventVariableMapping } from './variables';

export type EventCampaignStatus = 'active' | 'paused' | 'cancelled' | 'completed';
export type EventReminderStatus = 'scheduled' | 'processing' | 'queued' | 'skipped' | 'failed';

/** Why a reminder will never send. Stored in event_reminders.skip_reason. */
export type EventSkipReason =
  | 'quiet_hours_after_event'
  | 'already_past'
  | 'cancelled'
  | 'no_recipients'
  | 'too_late'
  | 'campaign_paused';

export interface EventCampaignRow {
  id: string;
  account_id: string;
  user_id: string;
  name: string;
  event_at: string;
  location: string | null;
  join_link: string | null;
  audience_tag_ids: string[];
  exclude_tag_ids: string[];
  quiet_enabled: boolean;
  quiet_from: string;
  quiet_to: string;
  status: EventCampaignStatus;
  created_at: string;
  updated_at: string;
}

export interface EventReminderRow {
  id: string;
  event_campaign_id: string;
  account_id: string;
  offset_minutes: number;
  template_name: string;
  template_language: string;
  variables: Record<string, EventVariableMapping>;
  header_media_url: string | null;
  send_at: string | null;
  status: EventReminderStatus;
  skip_reason: EventSkipReason | null;
  moved_by_quiet_hours: boolean;
  broadcast_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

/** One reminder as the create/add API receives it. */
export interface ReminderInput {
  offset_minutes: number;
  template_name: string;
  template_language?: string;
  variables?: Record<string, EventVariableMapping>;
  header_media_url?: string | null;
}