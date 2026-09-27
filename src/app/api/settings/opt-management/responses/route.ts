import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import type { OptDirection, OptResponseType } from '@/types';

// PUT /api/settings/opt-management/responses — upsert the opt-in or
// opt-out auto-response config for this account. One row per
// (account_id, direction) — the UNIQUE constraint from migration 044
// makes this a straightforward upsert, mirroring the settings-style
// GET/PUT of /api/whatsapp/config (one row per account) rather than
// the list-CRUD shape of quick-replies.
//
// Body: { direction: 'in' | 'out', enabled, response_type, template_id?, message_text? }

export async function PUT(request: Request) {
  let ctx;
  try {
    ctx = await requireRole('admin');
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

  const direction: OptDirection | null =
    body.direction === 'in' || body.direction === 'out' ? body.direction : null;
  if (!direction) {
    return NextResponse.json({ error: "direction must be 'in' or 'out'" }, { status: 400 });
  }

  const responseType: OptResponseType = body.response_type === 'template' ? 'template' : 'message';
  const enabled = body.enabled !== false;
  const templateId =
    responseType === 'template' && typeof body.template_id === 'string' && body.template_id
      ? body.template_id
      : null;
  const messageText =
    responseType === 'message' && typeof body.message_text === 'string'
      ? body.message_text
      : null;

  if (enabled && responseType === 'template' && !templateId) {
    return NextResponse.json(
      { error: 'template_id is required when response_type is "template"' },
      { status: 400 },
    );
  }
  if (enabled && responseType === 'message' && !messageText?.trim()) {
    return NextResponse.json(
      { error: 'message_text is required when response_type is "message"' },
      { status: 400 },
    );
  }

  const { data, error } = await supabaseAdmin()
    .from('opt_responses')
    .upsert(
      {
        account_id: ctx.accountId,
        direction,
        enabled,
        response_type: responseType,
        template_id: templateId,
        message_text: messageText,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'account_id,direction' },
    )
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ response: data });
}