import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import type { OptDirection, OptMatchType } from '@/types';

// Opt keywords — list-like, one row per keyword, same shape as
// quick-replies (POST /api/quick-replies): GET lists, POST adds one.
// Individual enable/disable + delete is ./[id]/route.ts.

// Enforced here (application layer) rather than a DB constraint — see
// the migration's design notes for why a CHECK/trigger can't easily
// count sibling rows.
const MAX_ENABLED_OPT_OUT_KEYWORDS = 5;

export async function GET() {
  try {
    const { supabase } = await requireRole('viewer');
    const { data, error } = await supabase
      .from('opt_keywords')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ keywords: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  let ctx;
  try {
    ctx = await requireRole('admin');
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

  const direction: OptDirection = body.direction === 'in' ? 'in' : 'out';
  const keyword = typeof body.keyword === 'string' ? body.keyword.trim() : '';
  const matchType: OptMatchType = body.match_type === 'exact' ? 'exact' : 'contains';
  const enabled = body.enabled !== false;

  if (!keyword) {
    return NextResponse.json({ error: 'keyword is required' }, { status: 400 });
  }

  if (direction === 'out' && enabled) {
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
          error: `You can have at most ${MAX_ENABLED_OPT_OUT_KEYWORDS} enabled opt-out keywords. Disable one before adding another.`,
        },
        { status: 400 },
      );
    }
  }

  const { data, error } = await supabaseAdmin()
    .from('opt_keywords')
    .insert({
      account_id: ctx.accountId,
      direction,
      keyword,
      match_type: matchType,
      enabled,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ keyword: data }, { status: 201 });
}