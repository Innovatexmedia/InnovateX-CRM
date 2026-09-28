import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';

// Enable/disable (PATCH) or remove (DELETE) a single opt keyword.
// Mirrors quick-replies/[id]/route.ts: account-scoped, admin-gated
// (opt keywords are compliance configuration, not day-to-day agent
// data — see the RLS policies in migration 044).

// Kept in sync with ./route.ts's POST-time check — see the migration's
// design notes for why this is enforced here rather than in SQL.
const MAX_ENABLED_OPT_OUT_KEYWORDS = 5;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let ctx;
  try {
    ctx = await requireRole('admin');
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

  const update: Record<string, unknown> = {};
  if (typeof body.keyword === 'string') {
    const keyword = body.keyword.trim();
    if (!keyword) return NextResponse.json({ error: 'keyword cannot be empty' }, { status: 400 });
    update.keyword = keyword;
  }
  if (body.match_type === 'exact' || body.match_type === 'contains') {
    update.match_type = body.match_type;
  }
  if (typeof body.enabled === 'boolean') {
    update.enabled = body.enabled;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: true });
  }

  // Re-enabling a keyword is subject to the same 5-enabled-opt-out cap
  // as creating one. Look up the row first so we know its direction
  // (an opt-in keyword has no cap).
  if (update.enabled === true) {
    const { data: existing, error: fetchError } = await supabaseAdmin()
      .from('opt_keywords')
      .select('direction, enabled')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (fetchError) {
      return NextResponse.json({ error: fetchError.message }, { status: 500 });
    }
    if (!existing) {
      return NextResponse.json({ error: 'Keyword not found' }, { status: 404 });
    }
    if (existing.direction === 'out' && !existing.enabled) {
      const { count, error: countError } = await supabaseAdmin()
        .from('opt_keywords')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', ctx.accountId)
        .eq('direction', 'out')
        .eq('enabled', true);
      if (countError) {
        return NextResponse.json({ error: countError.message }, { status: 500 });
      }
      if ((count ?? 0) >= MAX_ENABLED_OPT_OUT_KEYWORDS) {
        return NextResponse.json(
          {
            error: `You can have at most ${MAX_ENABLED_OPT_OUT_KEYWORDS} enabled opt-out keywords. Disable one before enabling another.`,
          },
          { status: 400 },
        );
      }
    }
  }

  const { error } = await supabaseAdmin()
    .from('opt_keywords')
    .update(update)
    .eq('id', id)
    .eq('account_id', ctx.accountId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let ctx;
  try {
    ctx = await requireRole('admin');
  } catch (err) {
    return toErrorResponse(err);
  }

  const { error } = await supabaseAdmin()
    .from('opt_keywords')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}