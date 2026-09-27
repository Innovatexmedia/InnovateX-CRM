import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';

// GET /api/settings/opt-management — the account's full opt-in/opt-out
// configuration in one round trip: every keyword (both directions) and
// the (at most 2) response rows, one per direction. Mirrors the
// quick-replies GET: RLS-scoped read via the user client, no service
// role needed for a read.
//
// Individual keyword CRUD lives in ./keywords (mirrors quick-replies'
// list-like shape); responses are upserted as a pair via ./responses.
// This route stays read-only so the settings panel has one place to
// load its initial state.

export async function GET() {
  try {
    const { supabase } = await getCurrentAccount();

    const [keywordsRes, responsesRes] = await Promise.all([
      supabase
        .from('opt_keywords')
        .select('*')
        .order('created_at', { ascending: true }),
      supabase
        .from('opt_responses')
        .select('*')
        .order('direction', { ascending: true }),
    ]);

    if (keywordsRes.error) {
      return NextResponse.json({ error: keywordsRes.error.message }, { status: 500 });
    }
    if (responsesRes.error) {
      return NextResponse.json({ error: responsesRes.error.message }, { status: 500 });
    }

    return NextResponse.json({
      keywords: keywordsRes.data ?? [],
      responses: responsesRes.data ?? [],
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}