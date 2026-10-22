import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';

/**
 * DELETE /api/events/[id]/reminders/[rid] — remove a reminder that has
 * not gone out yet. One already queued/sent stays: its broadcast is the
 * record of what was sent.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; rid: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id, rid } = await params;

    const { data, error } = await supabase
      .from('event_reminders')
      .delete()
      .eq('id', rid)
      .eq('event_campaign_id', id)
      .eq('account_id', accountId)
      .in('status', ['scheduled', 'skipped', 'failed'])
      .select('id')
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) {
      return NextResponse.json(
        { error: 'This reminder is not removable — it may have just started sending.' },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}