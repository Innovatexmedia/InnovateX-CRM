import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';

// Manual opt-in / opt-out from the dashboard (contact detail view).
// Mirrors contacts/[id]/tags/route.ts's auth pattern: session-authed,
// agent+ (the same role that can edit a contact), account-scoped via
// the RLS-backed user client (no service-role client needed — RLS on
// `contacts` already restricts UPDATE to agent+ of the same account).
//
// Body: { direction: 'in' | 'out' } — 'in' opts the contact in,
// 'out' opts them out. opt_source is always 'manual' here.

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('agent');
    const { id: contactId } = await params;

    const body = (await request.json().catch(() => null)) as {
      direction?: unknown;
    } | null;
    const direction = body?.direction === 'in' || body?.direction === 'out' ? body.direction : null;
    if (!direction) {
      return NextResponse.json({ error: "direction must be 'in' or 'out'" }, { status: 400 });
    }

    const now = new Date().toISOString();
    const update =
      direction === 'in'
        ? {
            subscription_status: 'opted_in' as const,
            opted_in_at: now,
            opt_source: 'manual' as const,
            updated_at: now,
          }
        : {
            subscription_status: 'opted_out' as const,
            opted_out_at: now,
            opt_source: 'manual' as const,
            updated_at: now,
          };

    const { data, error } = await ctx.supabase
      .from('contacts')
      .update(update)
      .eq('id', contactId)
      .eq('account_id', ctx.accountId)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ contact: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}