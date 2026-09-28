// ============================================================
// POST /api/v1/contacts/{id}/opt-out — mark a contact opted out via
// the public API (scope: contacts:write).
//
// Account-scoped like every other /api/v1/contacts/{id} route: a
// contact belonging to another account returns 404, never 403.
// Sets subscription_status='opted_out', opted_out_at=now(),
// opt_source='api'. Idempotent — opting out an already-opted-out
// contact just re-stamps opted_out_at.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { getContactById } from '@/lib/api/v1/contacts';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'contacts:write');
    const { id } = await params;

    const existing = await getContactById(ctx.supabase, ctx.accountId, id);
    if (!existing) return fail('not_found', 'Contact not found', 404);

    const { error } = await ctx.supabase
      .from('contacts')
      .update({
        subscription_status: 'opted_out',
        opted_out_at: new Date().toISOString(),
        opt_source: 'api',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('account_id', ctx.accountId);

    if (error) {
      console.error('[api/v1/contacts/opt-out] update error:', error);
      return fail('internal', 'Failed to opt out contact', 500);
    }

    const contact = await getContactById(ctx.supabase, ctx.accountId, id);
    return ok(contact);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}