// ============================================================
// API campaign send.
//
// An API campaign is a `broadcasts` row with kind = 'api' and status
// 'active'. Each call here adds ONE `broadcast_recipients` row to it and
// sends the campaign's template to that recipient right away. Counts on
// the campaign are maintained by the DB aggregate trigger (migrations
// 003/005) from the recipient rows, and later delivery/read webhooks
// advance them exactly as they do for ordinary broadcasts.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  parseInternationalPhone,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import { findOrCreateContact } from '@/lib/api/v1/contacts';
import { BroadcastError } from '@/lib/whatsapp/broadcast-core';

export interface ApiCampaignSendInput {
  /** E.164 phone with leading +. */
  to: string;
  /** Positional body params for the template ({{1}}, {{2}}…). */
  params?: string[];
}

export interface ApiCampaignSendResult {
  campaign_id: string;
  recipient_id: string;
  message_id: string;
  status: 'sent';
}

export async function sendApiCampaignMessage(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  campaignId: string,
  input: ApiCampaignSendInput
): Promise<ApiCampaignSendResult> {
  const { data: campaign, error: campaignErr } = await db
    .from('broadcasts')
    .select('id, template_name, template_language, status, kind')
    .eq('id', campaignId)
    .eq('account_id', accountId)
    .eq('kind', 'api')
    .maybeSingle();
  if (campaignErr) {
    console.error('[api-campaign] read error:', campaignErr);
    throw new BroadcastError('internal', 'Failed to read campaign', 500);
  }
  if (!campaign) {
    throw new BroadcastError('not_found', 'API campaign not found', 404);
  }
  if (campaign.status !== 'active') {
    throw new BroadcastError('conflict', 'This API campaign is not active', 409);
  }

  const sanitized = parseInternationalPhone(input.to);
  if (!sanitized) {
    throw new BroadcastError(
      'bad_request',
      "'to' must be an international phone number with a leading + and country code (e.g. +14155550123)",
      400
    );
  }
  const params = Array.isArray(input.params)
    ? input.params.filter((p): p is string => typeof p === 'string')
    : [];

  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single();
  if (configError || !config) {
    throw new BroadcastError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }
  const accessToken = decrypt(config.access_token);

  const resolvedTemplate = await resolveTemplateRow(
    db,
    accountId,
    campaign.template_name,
    campaign.template_language
  );
  if (resolvedTemplate.malformed) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it.',
      500
    );
  }

  const { id: contactId } = await findOrCreateContact(db, accountId, auditUserId, {
    phone: input.to,
  });

  // Hard, non-overridable compliance exclusion (migration 044) — same
  // rule as the dashboard broadcast send route: an opted-out contact
  // is never sent a campaign message, API caller or not.
  const { data: contactRow, error: contactCheckError } = await db
    .from('contacts')
    .select('subscription_status')
    .eq('id', contactId)
    .maybeSingle();
  if (contactCheckError) {
    console.error('[api-campaign] opt-status lookup failed:', contactCheckError);
  } else if (contactRow?.subscription_status === 'opted_out') {
    throw new BroadcastError(
      'recipient_opted_out',
      'This contact has opted out of WhatsApp messaging',
      409
    );
  }

  const { data: row, error: rowErr } = await db
    .from('broadcast_recipients')
    .insert({
      broadcast_id: campaign.id,
      contact_id: contactId,
      status: 'pending',
      template_params: params,
    })
    .select('id')
    .single();
  if (rowErr || !row) {
    console.error('[api-campaign] recipient insert error:', rowErr);
    throw new BroadcastError('internal', 'Failed to record recipient', 500);
  }

  let messageId: string | null = null;
  let lastError: string | null = null;
  for (const variant of phoneVariants(sanitized)) {
    try {
      const result = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: variant,
        templateName: campaign.template_name,
        language: resolvedTemplate.language,
        template: resolvedTemplate.row ?? undefined,
        params,
      });
      messageId = result.messageId;
      lastError = null;
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Unknown error';
      if (!isRecipientNotAllowedError(lastError)) break;
    }
  }

  if (!messageId) {
    await db
      .from('broadcast_recipients')
      .update({ status: 'failed', error_message: lastError || 'Unknown error' })
      .eq('id', row.id);
    await syncTotalRecipients(db, campaign.id);
    throw new BroadcastError(
      'send_failed',
      lastError || 'Failed to send template message',
      502
    );
  }

  await db
    .from('broadcast_recipients')
    .update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      whatsapp_message_id: messageId,
      error_message: null,
    })
    .eq('id', row.id);
  await syncTotalRecipients(db, campaign.id);

  return {
    campaign_id: campaign.id,
    recipient_id: row.id,
    message_id: messageId,
    status: 'sent',
  };
}

/** Keep `total_recipients` equal to the number of recipient rows. */
async function syncTotalRecipients(
  db: SupabaseClient,
  campaignId: string
): Promise<void> {
  const { count } = await db
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', campaignId);
  await db
    .from('broadcasts')
    .update({ total_recipients: count ?? 0, updated_at: new Date().toISOString() })
    .eq('id', campaignId);
}