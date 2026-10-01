// ============================================================
// Helpers for the Incoming Webhook trigger's "capture → map fields"
// flow — resolving CRM fields out of whatever JSON shape an external
// system actually sends, and flattening a sample payload into a list
// of pickable field paths for the builder's mapping UI.
// ============================================================

/** Depth/width guards on `flattenPayloadKeys` — this is untrusted
 *  external input; without a cap, a deeply nested or huge object could
 *  make the builder do a lot of pointless work for a dropdown list. */
const MAX_FLATTEN_DEPTH = 4
const MAX_FLATTEN_KEYS = 60

/**
 * Resolve a dot-path (as stored in `field_mapping`, e.g. `"contact.phone"`)
 * against a parsed JSON body. Returns `undefined` if any segment along
 * the way is missing or the path walks into a non-object.
 *
 * Deliberately does NOT support array indices (`items.0.sku`) — the
 * mapping UI only ever offers paths discovered by `flattenPayloadKeys`,
 * which stops at arrays rather than indexing into them (see below), so
 * this only needs to handle plain nested objects.
 */
export function getByPath(obj: unknown, path: string): unknown {
  if (!path) return undefined
  let cur: unknown = obj
  for (const segment of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, unknown>)[segment]
  }
  return cur
}

export interface FlattenedField {
  /** Dot-path suitable for `getByPath` / storing in `field_mapping`. */
  path: string
  /** Stringified preview of the value in the sample this was taken
   *  from, truncated — shown next to the field name in the mapping
   *  dropdown so the user can tell `contact.phone` from `billing.phone`
   *  at a glance without opening the raw payload. */
  preview: string
}

/**
 * Flatten a captured sample payload into the list of paths the mapping
 * UI lets a user choose from. Nested objects are walked (up to
 * `MAX_FLATTEN_DEPTH`); arrays are treated as leaves (previewed as
 * `[3 items]`) rather than indexed into, since "map to the 2nd item of
 * an array" isn't a mapping a non-technical user should have to
 * reason about — if that level of transform is ever needed it belongs
 * in a dedicated step, not this picker.
 */
export function flattenPayloadKeys(
  payload: Record<string, unknown>,
  prefix = '',
  depth = 0,
  out: FlattenedField[] = [],
): FlattenedField[] {
  if (depth >= MAX_FLATTEN_DEPTH) return out
  for (const [key, value] of Object.entries(payload)) {
    if (out.length >= MAX_FLATTEN_KEYS) return out
    const path = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flattenPayloadKeys(value as Record<string, unknown>, path, depth + 1, out)
    } else {
      out.push({ path, preview: previewValue(value) })
    }
  }
  return out
}

function previewValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? '' : 's'}]`
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  return s.length > 40 ? `${s.slice(0, 40)}…` : s
}

/**
 * Resolve the CRM-facing fields (phone, name, tags, vars) from a
 * received body, using `field_mapping` when the automation has one
 * configured, or the original fixed `{ phone, name, vars }` shape
 * otherwise. Shared between the live dispatch path and anywhere else
 * that needs to preview "what would this mapping produce" against a
 * captured sample.
 */
export interface ResolvedWebhookFields {
  phone: string | null
  name: string | null
  /** Written onto the contact row (`contacts.email`) — distinct from
   *  `vars`, which only ever lives inside a rendered message. */
  email: string | null
  /** Written onto the contact row (`contacts.company`). */
  company: string | null
  tags: string[]
  /** `custom_field_id -> resolved value` — upserted into
   *  `contact_custom_values`, same as `email`/`company` are written
   *  onto `contacts` (not just available inside a message, unlike
   *  `vars`). See `@/lib/contacts/custom-field-write`. */
  customFields: Record<string, string>
  vars: Record<string, string>
}

const MAX_VARS_KEYS = 20
const MAX_VAR_VALUE_LEN = 1000

function toVarString(v: unknown): string | null {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return String(v).slice(0, MAX_VAR_VALUE_LEN)
  }
  return null
}

function toTagList(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean)
  }
  if (typeof v === 'string') {
    return v
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
  }
  return []
}

export function resolveWebhookFields(
  body: Record<string, unknown>,
  fieldMapping:
    | {
        phone: string
        name?: string
        tags?: string
        email?: string
        company?: string
        custom_fields?: Record<string, string>
        vars?: Record<string, string>
      }
    | undefined,
): ResolvedWebhookFields {
  if (!fieldMapping) {
    // Legacy fixed shape — unchanged from the original implementation.
    // No `email`/`company` here: the original fixed contract never had
    // them, and adding fields to it now would be a silent behavior
    // change for whatever's already integrated against it.
    const phone = typeof body.phone === 'string' ? body.phone.trim() || null : null
    const name = typeof body.name === 'string' ? body.name.trim() || null : null
    const vars: Record<string, string> = {}
    if (body.vars && typeof body.vars === 'object' && !Array.isArray(body.vars)) {
      const entries = Object.entries(body.vars as Record<string, unknown>).slice(0, MAX_VARS_KEYS)
      for (const [k, v] of entries) {
        const s = toVarString(v)
        if (s !== null) vars[k] = s
      }
    }
    return { phone, name, email: null, company: null, tags: [], customFields: {}, vars }
  }

  const phoneRaw = getByPath(body, fieldMapping.phone)
  const phone = typeof phoneRaw === 'string' ? phoneRaw.trim() || null : null
  const nameRaw = fieldMapping.name ? getByPath(body, fieldMapping.name) : undefined
  const name = typeof nameRaw === 'string' ? nameRaw.trim() || null : null
  const emailRaw = fieldMapping.email ? getByPath(body, fieldMapping.email) : undefined
  const email = typeof emailRaw === 'string' ? emailRaw.trim() || null : null
  const companyRaw = fieldMapping.company ? getByPath(body, fieldMapping.company) : undefined
  const company = typeof companyRaw === 'string' ? companyRaw.trim() || null : null
  const tags = fieldMapping.tags ? toTagList(getByPath(body, fieldMapping.tags)) : []

  const vars: Record<string, string> = {}
  if (fieldMapping.vars) {
    const entries = Object.entries(fieldMapping.vars).slice(0, MAX_VARS_KEYS)
    for (const [destKey, sourcePath] of entries) {
      const s = toVarString(getByPath(body, sourcePath))
      if (s !== null) vars[destKey] = s
    }
  }

  const customFields: Record<string, string> = {}
  if (fieldMapping.custom_fields) {
    const entries = Object.entries(fieldMapping.custom_fields).slice(0, MAX_VARS_KEYS)
    for (const [customFieldId, sourcePath] of entries) {
      const s = toVarString(getByPath(body, sourcePath))
      if (s !== null) customFields[customFieldId] = s
    }
  }

  return { phone, name, email, company, tags, customFields, vars }
}