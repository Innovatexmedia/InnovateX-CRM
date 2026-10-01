import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Upsert `(contact_id, custom_field_id) -> value` rows for the
 * Incoming Webhook trigger's `field_mapping.custom_fields` mapping —
 * the same write the `update_contact_field` automation step makes for
 * a `custom:<id>` destination (see `@/lib/automations/engine`'s
 * `update_contact_field` case), kept here as its own small helper
 * instead of reusing that step's code directly: the step reads its
 * destination out of a single `step_config.field` string already
 * known to be `custom:<id>`-shaped, where this is called once per
 * mapped field straight off `ResolvedWebhookFields.customFields`
 * (`custom_field_id -> value`, no prefix), so there's no shared
 * "parse the field string" step to factor out between them — just the
 * same upsert shape.
 *
 * Defense in depth, mirroring the step: confirms each `custom_field_id`
 * actually belongs to `accountId` before writing (the caller passes a
 * service-role client that bypasses RLS) — a stale or cross-account id
 * left over in an automation's `field_mapping` after a custom field is
 * deleted, or a config this route never meant to trust blindly, is
 * silently skipped rather than written against someone else's field
 * definition or failing the whole request over one bad id.
 *
 * Best-effort per field: one field failing (not owned, or a transient
 * DB error) does not stop the others from being written, matching how
 * the webhook route treats tag attachment — a personalization/record-
 * keeping nicety should never take down the actual automation run.
 */
export async function upsertContactCustomValues(
  db: SupabaseClient,
  input: { accountId: string; contactId: string; values: Record<string, string> },
): Promise<void> {
  const entries = Object.entries(input.values).filter(([id]) => id.trim().length > 0)
  if (entries.length === 0) return

  const { data: owned, error: lookupErr } = await db
    .from('custom_fields')
    .select('id')
    .eq('account_id', input.accountId)
    .in(
      'id',
      entries.map(([id]) => id),
    )

  if (lookupErr) {
    console.error('[custom-field-write] ownership lookup failed:', lookupErr)
    return
  }

  const ownedIds = new Set((owned ?? []).map((row) => (row as { id: string }).id))

  for (const [customFieldId, value] of entries) {
    if (!ownedIds.has(customFieldId)) continue
    const { error } = await db
      .from('contact_custom_values')
      .upsert(
        { contact_id: input.contactId, custom_field_id: customFieldId, value },
        { onConflict: 'contact_id,custom_field_id' },
      )
    if (error) {
      console.error('[custom-field-write] upsert failed:', customFieldId, error)
    }
  }
}