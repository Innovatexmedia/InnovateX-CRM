import type { SupabaseClient } from '@supabase/supabase-js'

/** Default color for a tag created automatically from webhook data —
 *  same default `tag-manager.tsx` uses for a manually created tag, so
 *  an auto-created tag doesn't stand out as "system-generated" in the
 *  tag list. */
const DEFAULT_TAG_COLOR = '#3b82f6'

/**
 * Resolve a list of tag NAMES (as a webhook's `field_mapping.tags`
 * produces — free text from whatever external system sent them, e.g.
 * "hot", "Bizparadise") to this account's tag IDs, creating any tag
 * that doesn't exist yet. This is what makes the Incoming Webhook
 * trigger's tag mapping behave like AiSensy/Intercom's — a tag name
 * arriving in a payload becomes a real, visible CRM tag automatically,
 * not just a string sitting in `{{vars.tags}}`.
 *
 * Matching is case-insensitive (`"Hot"` and `"hot"` resolve to the
 * same tag) since that's how a human skimming the Tags page expects
 * duplicates to be avoided, but the tag keeps whichever casing it was
 * first created with.
 *
 * Not transaction-safe against a concurrent duplicate-name insert —
 * `tags` has no unique constraint on (account_id, name) to upsert
 * against (pre-existing schema, not something this feature should
 * retrofit under a client's live data). Two webhook hits racing to
 * create the same new tag name in the same instant could each create
 * one; this is an accepted, narrow edge case, not a correctness bug
 * that affects normal usage (the common case is the tag already
 * existing after its first creation).
 */
export async function findOrCreateTagsByName(
  db: SupabaseClient,
  input: { accountId: string; userId: string; names: string[] },
): Promise<string[]> {
  const trimmed = input.names
    .map((n) => n.trim())
    .filter(Boolean)
    .slice(0, 20) // same cap as MAX_VARS_KEYS elsewhere — a webhook payload's tag list is never meant to be large

  // Dedupe case-insensitively, keeping the FIRST-seen casing — `new Map(entries)`
  // keeps the LAST value for a repeated key, which is the opposite of what we want here.
  const byLower = new Map<string, string>()
  for (const name of trimmed) {
    const lower = name.toLowerCase()
    if (!byLower.has(lower)) byLower.set(lower, name)
  }
  const wanted = Array.from(byLower.values())
  if (wanted.length === 0) return []

  const { data: existing, error: lookupErr } = await db
    .from('tags')
    .select('id, name')
    .eq('account_id', input.accountId)

  if (lookupErr) {
    console.error('[tag-find-or-create] lookup failed:', lookupErr)
    return []
  }

  const byLowerName = new Map<string, string>()
  for (const row of (existing ?? []) as { id: string; name: string }[]) {
    byLowerName.set(row.name.toLowerCase(), row.id)
  }

  const toCreate = wanted.filter((name) => !byLowerName.has(name.toLowerCase()))
  if (toCreate.length > 0) {
    const { data: created, error: insertErr } = await db
      .from('tags')
      .insert(
        toCreate.map((name) => ({
          user_id: input.userId,
          account_id: input.accountId,
          name,
          color: DEFAULT_TAG_COLOR,
        })),
      )
      .select('id, name')
    if (insertErr) {
      console.error('[tag-find-or-create] insert failed:', insertErr)
    } else {
      for (const row of (created ?? []) as { id: string; name: string }[]) {
        byLowerName.set(row.name.toLowerCase(), row.id)
      }
    }
  }

  const ids: string[] = []
  for (const name of wanted) {
    const id = byLowerName.get(name.toLowerCase())
    if (id) ids.push(id)
  }
  return ids
}