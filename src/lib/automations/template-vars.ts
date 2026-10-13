// ============================================================
// Resolve the positional {{1}}, {{2}}, … values of a Send Template
// automation step for ONE contact.
//
// The step stores `variables: { "1": "{{ contact.name }}", "2": "Friday 7pm" }`
// plus an optional `fallbacks: { "1": "there" }`. At run time each value
// is rendered against the contact + the trigger's `vars`; if the result
// is blank the fallback is used; if that is blank too we fail with a
// clear message BEFORE calling Meta (Meta only answers with a bare
// "#132000 Number of parameters does not match" / empty-parameter error).
// ============================================================

export interface TemplateVarContact {
  name?: string | null
  phone?: string | null
  email?: string | null
  company?: string | null
}

export interface TemplateVarContext {
  contact: TemplateVarContact
  /** Trigger variables, e.g. the incoming webhook's mapped `vars`. */
  vars?: Record<string, unknown>
  messageText?: string | null
}

const TOKEN_RE = /\{\{\s*([\w.]+)\s*\}\}/g

/** Render `{{ contact.name }}`, `{{ vars.order_id }}`, `{{ message.text }}`
 *  inside one value. Unknown tokens render as an empty string. */
export function renderTemplateValue(value: string, ctx: TemplateVarContext): string {
  return value.replace(TOKEN_RE, (_, key: string) => {
    const [ns, prop] = key.split('.')
    if (ns === 'contact' && prop) {
      const v = ctx.contact[prop as keyof TemplateVarContact]
      return v == null ? '' : String(v)
    }
    if (ns === 'vars' && prop) {
      const v = ctx.vars?.[prop]
      return v == null ? '' : String(v)
    }
    if (ns === 'message' && prop === 'text') return String(ctx.messageText ?? '')
    return ''
  })
}

function sortedKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).sort((a, b) => {
    const na = Number(a)
    const nb = Number(b)
    const aNum = Number.isFinite(na)
    const bNum = Number.isFinite(nb)
    if (aNum && bNum) return na - nb
    if (aNum) return -1
    if (bNum) return 1
    return a.localeCompare(b)
  })
}

/**
 * Body parameters in strict numeric order ("1", "2", …, "10" — never
 * lexicographic). Newlines/tabs are flattened and long space runs
 * collapsed, since Meta rejects them inside a text parameter.
 */
export function resolveTemplateParams(
  variables: Record<string, string> | undefined,
  fallbacks: Record<string, string> | undefined,
  ctx: TemplateVarContext,
): string[] {
  if (!variables) return []
  return sortedKeys(variables).map((key) => {
    const clean = (s: string) =>
      s
        .replace(/\r\n|\r|\n|\t/g, ' ')
        .replace(/ {4,}/g, '   ')
        .trim()

    const rendered = clean(renderTemplateValue(String(variables[key] ?? ''), ctx))
    if (rendered) return rendered

    const fallback = clean(String(fallbacks?.[key] ?? ''))
    if (fallback) return fallback

    throw new Error(
      `Template variable {{${key}}} is empty for this contact. Pick a field that has a value, or set a fallback value for {{${key}}} in the Send Template step.`,
    )
  })
}