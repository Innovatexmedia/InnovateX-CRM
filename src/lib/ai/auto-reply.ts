import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt, buildHandoffNoticePrompt } from './defaults'
import {
  buildHandoffSummary,
  buildAgentAssignedNotice,
  isValidHandoffNotice,
  sanitizeAgentName,
  type HandoffReason,
} from './handoff'
import { detectHumanRequest } from './human-request'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import type { AiConfig, ChatMessage } from './types'
import {
  engineSendText,
  loadAccountMetaCredentials,
} from '@/lib/flows/meta-send'
import { sendTypingIndicator } from '@/lib/whatsapp/meta-api'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
  /** Meta's wamid of the customer message we're replying to. When set,
   *  a typing indicator (which also marks it read) is shown while the
   *  reply is generated. Optional so older callers keep working. */
  inboundMessageId?: string
}

/**
 * Loop guard for "unlimited" accounts (and a backstop for capped ones):
 * if the bot has already sent this many replies in this one thread
 * within the window, something is wrong (the customer's own auto-
 * responder, a script, a stuck conversation) — pause and hand off to a
 * human instead of burning the owner's API key.
 */
export const BURST_MAX_REPLIES = 20
export const BURST_WINDOW_MS = 10 * 60 * 1000

/** A handoff target that is confirmed to still belong to the account. */
interface HandoffAgent {
  userId: string
  /** Sanitised display name, or null when the profile has none. */
  name: string | null
}

type Db = ReturnType<typeof supabaseAdmin>

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the contact has opted out (e.g. just sent STOP)
 *   - there's nothing to reply to
 *
 * Handoff triggers (the bot pauses THIS thread, announces who is taking
 * over, assigns the chat, and the assignment notifies the agent):
 *   - the customer clearly asks for a human (detected before the model)
 *   - the model decides it can't help
 *   - the per-conversation reply cap is reached (cap 0 = unlimited)
 *   - the burst guard trips (too many bot replies in a short window)
 *
 * Every write is scoped to this one conversation id, so pausing or
 * assigning here never affects another thread in the inbox.
 *
 * One gate lives at the CALL SITE, not here: the caller (the webhook
 * route) does not invoke this function at all when a `flowConsumed` OR
 * a responder Automation (`new_message_received` / `keyword_match`)
 * actually matched this inbound. That's a deliberate per-message
 * waterfall — deterministic responders win, AI handles whatever they
 * didn't — rather than an account-wide "an automation of that type is
 * merely active somewhere" block. See the comment on
 * `runAutomationsForTrigger` in src/lib/automations/engine.ts.
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const {
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    inboundMessageId,
  } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here

    // Opted-out contacts (STOP and friends) must not be answered by the
    // bot. The webhook applies opt-out keywords BEFORE this runs, so a
    // customer who just typed STOP is already `opted_out` here. Fail
    // open on a lookup error — a flaky read must not silence the bot.
    if (await isContactOptedOut(db, accountId, contactId)) return

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    const replyCount = conv.ai_reply_count ?? 0
    const handoffCtx = {
      db,
      accountId,
      conversationId,
      contactId,
      configOwnerUserId,
      config,
      messages,
      replyCount,
    }

    // Reply cap reached. A cap of 0 means unlimited. Reaching a finite
    // cap hands the chat to a human (as the Settings copy promises)
    // instead of leaving the customer talking to a silent bot.
    // Cheap early check; the authoritative cap check is the atomic
    // claim below (this read can race a concurrent inbound).
    const cap = config.autoReplyMaxPerConversation
    if (cap > 0 && replyCount >= cap) {
      await performHandoff({ ...handoffCtx, reason: 'cap', noticeText: null })
      return
    }

    // Burst guard — see BURST_MAX_REPLIES. Fails open on a lookup error.
    if (await isBurstingReplies(db, conversationId)) {
      console.warn(
        `[ai auto-reply] conversation ${conversationId} tripped the burst guard — pausing and handing off.`,
      )
      await performHandoff({ ...handoffCtx, reason: 'burst', noticeText: null })
      return
    }

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }
    // The in-memory bucket above is per server instance; on serverless,
    // N warm instances would each allow a full quota. This second check
    // reads shared state (the usage log) so the account-wide limit holds
    // across instances. Approximate by design (the log write is async)
    // and fails open.
    if (await isAccountOverSharedBudget(db, accountId)) {
      console.warn(
        `[ai auto-reply] account ${accountId} is over the shared per-minute AI budget — skipping this inbound.`,
      )
      return
    }

    // Every gate has passed — we're committed to attempting a reply, so
    // show the customer "typing…" (and mark their message read) while the
    // retrieval + LLM round trips run. Meta clears the indicator after
    // 25 s or when our reply lands, whichever is first, so there's
    // nothing to undo on the handoff / no-text path. Strictly
    // best-effort: a failed indicator must never cost us the reply.
    if (inboundMessageId) {
      await showTypingIndicator(db, accountId, inboundMessageId)
    }

    // Who a handoff would go to — resolved up front (one tiny query) so
    // the model can announce them by name. Null when no target is
    // configured, or the configured person is no longer on the account.
    const agent = await resolveHandoffAgent(db, accountId, config.handoffAgentId)

    // A clear "I want a human" never depends on the model noticing. Skip
    // normal answering and hand off now.
    if (detectHumanRequest(latestUserMessage(messages))) {
      const noticeText = await composeCustomerRequestNotice({
        db,
        accountId,
        conversationId,
        config,
        agent,
        messages,
      })
      await performHandoff({
        ...handoffCtx,
        reason: 'customer_request',
        noticeText,
        agent,
      })
      return
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      handoffAgentName: agent?.name ?? null,
    })

    // A provider failure (bad key, outage, rate limit, empty reply) must
    // never be silent: the customer would just be ignored and nobody
    // would know why. Don't retry (a retry storm on a down provider
    // helps nobody) and don't pretend the AI answered — pause the bot on
    // this thread and hand it to a human, with the cause in the internal
    // note.
    let generated: Awaited<ReturnType<typeof generateReply>>
    try {
      generated = await generateReply({ config, systemPrompt, messages })
    } catch (err) {
      const code = (err as { code?: string } | null)?.code ?? 'ai_error'
      console.error(`[ai auto-reply] generation failed (${code}) — handing off:`, err)
      await performHandoff({
        ...handoffCtx,
        reason: 'error',
        noticeText: null,
        agent,
        detail: code,
      })
      return
    }
    const { text, handoff, usage } = generated

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    if (handoff || !text) {
      // The model can't (or shouldn't) answer. When it handed off while
      // an agent is configured it was asked to write the announcement in
      // the customer's language — trust it only if it passes validation,
      // otherwise the fixed template is used.
      const modelNotice =
        handoff && agent?.name && isValidHandoffNotice(text, agent.name)
          ? text.trim()
          : null
      await performHandoff({
        ...handoffCtx,
        reason: 'model',
        noticeText: modelNotice,
        agent,
      })
      return
    }

    // A human may have taken the chat (or someone paused the bot) while
    // the model was thinking — re-read the thread's state so we never
    // talk over them.
    const { data: fresh } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled')
      .eq('id', conversationId)
      .maybeSingle()
    if (!fresh || fresh.assigned_agent_id || fresh.ai_autoreply_disabled) return

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) return // lost the per-conversation cap race

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiGenerated: true,
    })
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}

// ------------------------------------------------------------
// Handoff
// ------------------------------------------------------------

interface HandoffArgs {
  db: Db
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  config: AiConfig
  messages: ChatMessage[]
  replyCount: number
  reason: HandoffReason
  /** Customer-facing announcement to send before assigning. Null → the
   *  fixed template (or nothing at all for the silent `burst` reason). */
  noticeText: string | null
  /** Resolved target; looked up here when the caller hasn't already. */
  agent?: HandoffAgent | null
  /** Technical detail recorded in the internal note (e.g. AI error code). */
  detail?: string
}

/**
 * Pause the bot on this thread, tell the customer who is taking over,
 * then assign the chat so the agent is notified.
 *
 * Order matters and is concurrency-safe:
 *   1. CLAIM the handoff atomically — flip `ai_autoreply_disabled`
 *      false→true (only while the thread is still unassigned) and write
 *      the internal summary in the same statement. Of several concurrent
 *      inbounds (a customer typing "agent agent agent"), exactly one
 *      wins; the rest return, so the customer gets ONE announcement and
 *      the agent ONE notification.
 *   2. Send the customer announcement (best-effort — a failed send must
 *      never block the handoff).
 *   3. Assign the agent, guarded by `assigned_agent_id IS NULL` so a
 *      human who grabbed the chat in the meantime is never overwritten.
 *      The DB trigger `on_conversation_assigned` then notifies the agent.
 *
 * Every statement is filtered on this conversation's id (+ account), so
 * no other thread is touched.
 */
async function performHandoff(args: HandoffArgs): Promise<void> {
  const {
    db,
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    config,
    messages,
    replyCount,
    reason,
    noticeText,
  } = args

  const summary = buildHandoffSummary({
    messages,
    replyCount,
    reason,
    detail: args.detail,
  })

  // 1. Atomic claim.
  const { data: won, error: claimErr } = await db
    .from('conversations')
    .update({ ai_autoreply_disabled: true, ai_handoff_summary: summary })
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .eq('ai_autoreply_disabled', false)
    .is('assigned_agent_id', null)
    .select('id')
  if (claimErr) {
    console.error('[ai auto-reply] handoff claim failed:', claimErr)
    return
  }
  if (!won || won.length === 0) return // someone else already handled it

  // Resolve the target now if the caller didn't (cap / burst paths).
  const agent =
    args.agent !== undefined
      ? args.agent
      : await resolveHandoffAgent(db, accountId, config.handoffAgentId)

  // 2. Announce — except for `burst`, where replying more would only
  //    feed a suspected bot loop.
  if (reason !== 'burst') {
    const text = noticeText ?? buildAgentAssignedNotice(agent?.name ?? null)
    try {
      await engineSendText({
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        text,
        aiGenerated: true,
      })
    } catch (err) {
      console.warn('[ai auto-reply] handoff notice failed (continuing):', err)
    }
  }

  // 3. Assign (never stomp a human who took the chat meanwhile).
  if (agent) {
    const { error: assignErr } = await db
      .from('conversations')
      .update({ assigned_agent_id: agent.userId })
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .is('assigned_agent_id', null)
    if (assignErr) {
      console.error('[ai auto-reply] handoff assignment failed:', assignErr)
    }
  }
}

/**
 * Phrase the "X has been assigned" announcement in the customer's own
 * language for the customer-asked-for-a-human path. One small model call
 * (the main answer is already decided); validated, with the fixed
 * English template as the fallback — a model/provider hiccup must never
 * delay or block the handoff itself.
 */
async function composeCustomerRequestNotice(args: {
  db: Db
  accountId: string
  conversationId: string
  config: AiConfig
  agent: HandoffAgent | null
  messages: ChatMessage[]
}): Promise<string | null> {
  const { db, accountId, conversationId, config, agent, messages } = args
  if (!agent?.name) return null
  try {
    const { text, usage } = await generateReply({
      config,
      systemPrompt: buildHandoffNoticePrompt(agent.name),
      messages,
    })
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })
    return isValidHandoffNotice(text, agent.name) ? text.trim() : null
  } catch (err) {
    console.warn('[ai auto-reply] handoff notice generation failed (using template):', err)
    return null
  }
}

/**
 * The configured handoff agent, confirmed to STILL be a member of this
 * account (a teammate can be removed after the setting was saved). Null
 * when none is configured, the person is gone, or the lookup fails —
 * the chat then goes to the shared queue instead of a stranger.
 */
async function resolveHandoffAgent(
  db: Db,
  accountId: string,
  agentUserId: string | null,
): Promise<HandoffAgent | null> {
  if (!agentUserId) return null
  try {
    const { data } = await db
      .from('profiles')
      .select('user_id, full_name, account_role')
      .eq('account_id', accountId)
      .eq('user_id', agentUserId)
      .maybeSingle()
    const row = data as {
      user_id?: string
      full_name?: string | null
      account_role?: string | null
    } | null
    if (!row?.user_id) {
      console.warn(
        `[ai auto-reply] configured handoff agent ${agentUserId} is no longer on account ${accountId} — using the shared queue.`,
      )
      return null
    }
    // A viewer can read but not reply — assigning them a chat would park
    // it with someone who cannot answer. (A missing role is tolerated so
    // an older schema never blocks handoffs.)
    if (row.account_role === 'viewer') {
      console.warn(
        `[ai auto-reply] configured handoff agent ${agentUserId} is a viewer and cannot handle chats — using the shared queue.`,
      )
      return null
    }
    return { userId: row.user_id, name: sanitizeAgentName(row.full_name) }
  } catch (err) {
    console.warn('[ai auto-reply] handoff agent lookup failed (using shared queue):', err)
    return null
  }
}

// ------------------------------------------------------------
// Guards
// ------------------------------------------------------------

async function isContactOptedOut(
  db: Db,
  accountId: string,
  contactId: string,
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from('contacts')
      .select('subscription_status')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (error) return false
    return (data as { subscription_status?: string } | null)?.subscription_status === 'opted_out'
  } catch {
    return false
  }
}

async function isAccountOverSharedBudget(db: Db, accountId: string): Promise<boolean> {
  try {
    const since = new Date(Date.now() - 60_000).toISOString()
    const { count, error } = await db
      .from('ai_usage_log')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .eq('mode', 'auto_reply')
      .gte('created_at', since)
    if (error) return false
    return (count ?? 0) >= RATE_LIMITS.aiAutoReplyAccount.limit
  } catch {
    return false
  }
}

async function isBurstingReplies(db: Db, conversationId: string): Promise<boolean> {
  try {
    const since = new Date(Date.now() - BURST_WINDOW_MS).toISOString()
    const { count, error } = await db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conversationId)
      .eq('ai_generated', true)
      .gte('created_at', since)
    if (error) return false
    return (count ?? 0) >= BURST_MAX_REPLIES
  } catch {
    return false
  }
}

/**
 * Best-effort "typing…" for the inbound we're about to answer. Swallows
 * every failure (no WhatsApp config, bad token, Meta 4xx) with a warning
 * — the indicator is cosmetic, the reply is not.
 */
async function showTypingIndicator(
  db: Db,
  accountId: string,
  inboundMessageId: string,
): Promise<void> {
  try {
    const { phoneNumberId, accessToken } = await loadAccountMetaCredentials(
      db,
      accountId,
    )
    await sendTypingIndicator({
      phoneNumberId,
      accessToken,
      messageId: inboundMessageId,
    })
  } catch (err) {
    console.warn('[ai auto-reply] typing indicator failed (continuing):', err)
  }
}