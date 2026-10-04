import type { ChatMessage } from './types'

/** Longest the quoted customer message runs before we ellipsize it —
 *  keeps the internal note to a glanceable one-liner. */
const MAX_QUOTE_LEN = 160

export type HandoffReason =
  | 'model' // the model decided it can't help
  | 'customer_request' // the customer asked for a human
  | 'cap' // the per-conversation reply cap was reached
  | 'burst' // unusually many bot replies in a short window (loop guard)
  | 'error' // the AI provider failed (bad key, outage, rate limit, empty reply)

const REASON_TEXT: Record<HandoffReason, string> = {
  model: 'the assistant could not confidently help',
  customer_request: 'the customer asked for a human',
  cap: 'the per-conversation AI reply limit was reached',
  burst: 'unusually many AI replies in a short time (possible bot loop)',
  error: 'the AI service was unavailable, so this chat needs a human (check the AI settings / provider status)',
}

/**
 * Build the short internal note the auto-reply bot leaves on a
 * conversation when it hands off to a human. Deterministic — composed
 * from context we already have (no extra LLM call / token spend), so it
 * can't fail or add latency to the handoff.
 *
 * Reads as, e.g.:
 *   "🤖 AI agent handed off after 2 replies. Last customer message:
 *    “can I speak to a manager about my refund?”"
 *
 * `replyCount` is the bot's auto-reply tally for the thread (0 when it
 * bailed on the very first inbound without answering).
 */
export function buildHandoffSummary(args: {
  messages: ChatMessage[]
  replyCount: number
  /** Why the bot handed off. Optional: omitted → the original wording. */
  reason?: HandoffReason
  /** Short technical detail appended to the reason (e.g. the AI error
   *  code) so whoever picks the chat up can tell WHY. */
  detail?: string
}): string {
  const { messages, replyCount, reason, detail } = args

  const lastCustomer = [...messages]
    .reverse()
    .find((m) => m.role === 'user' && m.content.trim())

  const replies =
    replyCount === 0
      ? 'without replying'
      : `after ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`

  const base = `🤖 AI agent handed off ${replies}.${
    reason ? ` Reason: ${REASON_TEXT[reason]}${detail ? ` [${detail}]` : ''}.` : ''
  }`

  if (!lastCustomer) return base

  const quote = truncate(lastCustomer.content.trim(), MAX_QUOTE_LEN)
  return `${base} Last customer message: “${quote}”`
}

/** Longest agent name we will put in a customer-facing message. */
const MAX_AGENT_NAME_LEN = 60
/** Longest model-written notice we accept (it should be one sentence). */
const MAX_NOTICE_LEN = 300

/**
 * Clean a profile's display name for use in a customer-facing message:
 * collapse whitespace/newlines, strip control characters, cap length.
 * Returns null for blank names so callers fall back to generic wording.
 */
export function sanitizeAgentName(raw: string | null | undefined): string | null {
  if (!raw) return null
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_AGENT_NAME_LEN)
    .trim()
  return cleaned || null
}

/**
 * The message the bot sends the customer right BEFORE it assigns their
 * chat to a human, so the customer knows who is picking it up. Names the
 * agent when we have one; otherwise tells them the chat went to the
 * team (never an empty or "null" name).
 */
export function buildAgentAssignedNotice(agentName: string | null | undefined): string {
  const name = sanitizeAgentName(agentName)
  return name
    ? `I've assigned ${name} to your chat. They'll reply here shortly.`
    : `I've passed your chat to our team. Someone will reply here shortly.`
}

/**
 * Accept a model-written notice (which is in the customer's language)
 * only if it is safe to send verbatim: a short single message that
 * actually mentions the assigned agent by name and carries no leftover
 * control marker. Anything else → the caller uses the fixed template.
 */
export function isValidHandoffNotice(
  text: string | null | undefined,
  agentName: string,
): boolean {
  const t = text?.trim()
  if (!t || t.length > MAX_NOTICE_LEN) return false
  if (t.includes('[[') || t.includes(']]')) return false
  return t.toLowerCase().includes(agentName.toLowerCase())
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ')
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max - 1).trimEnd()}…`
}