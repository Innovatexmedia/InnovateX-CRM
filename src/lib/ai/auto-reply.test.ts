import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

type Filter = [string, string, unknown]
interface UpdateCall {
  table: string
  payload: Record<string, unknown>
  filters: Filter[]
}

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  loadAccountMetaCredentials: vi.fn(),
  sendTypingIndicator: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    /** Optional queue of conversation reads: each read shifts one off
     *  (then falls back to `conv`) — models state changing mid-flight. */
    convSeq: [] as Array<Record<string, unknown> | null>,
    claim: true as boolean,
    rpcCalls: [] as { name: string; args: unknown }[],
    /** `profiles` row for the configured handoff agent (null = gone). */
    agent: null as { user_id: string; full_name: string | null; account_role?: string } | null,
    /** `contacts.subscription_status`. */
    subscription: 'opted_in' as string,
    /** Rows the shared per-minute budget check sees in ai_usage_log. */
    usageCount: 0,
    /** How many ai_generated bot messages the burst guard sees. */
    recentBotReplies: 0,
    /** Does this worker win the atomic handoff claim? */
    claimWins: true,
    /** Every UPDATE issued, in order. */
    updates: [] as UpdateCall[],
    /** Order of side effects: 'claim' | 'send' | 'assign'. */
    order: [] as string[],
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: h.engineSendText,
  loadAccountMetaCredentials: h.loadAccountMetaCredentials,
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTypingIndicator: h.sendTypingIndicator,
}))
vi.mock('./admin-client', () => {
  const { state } = h

  interface Op {
    table: string
    type: 'select' | 'update'
    payload: Record<string, unknown>
    filters: Filter[]
    head: boolean
    returning: boolean
  }

  function resolve(op: Op) {
    const { table, type } = op
    if (type === 'update') {
      state.updates.push({ table, payload: op.payload, filters: op.filters })
      if ('ai_handoff_summary' in op.payload && op.payload.ai_autoreply_disabled === true) {
        state.order.push('claim')
        if (state.claimWins) {
          state.conv = { ...(state.conv ?? {}), ai_autoreply_disabled: true }
        }
        return { data: state.claimWins ? [{ id: 'conv-1' }] : [], error: null }
      }
      if ('assigned_agent_id' in op.payload) {
        state.order.push('assign')
        state.conv = { ...(state.conv ?? {}), assigned_agent_id: op.payload.assigned_agent_id }
      }
      return { data: null, error: null }
    }
    if (table === 'profiles') return { data: state.agent, error: null }
    if (table === 'contacts') {
      return { data: { subscription_status: state.subscription }, error: null }
    }
    if (table === 'ai_usage_log') {
      return { count: state.usageCount, data: null, error: null }
    }
    if (table === 'messages') {
      return { count: state.recentBotReplies, data: null, error: null }
    }
    if (state.convSeq.length > 0) return { data: state.convSeq.shift(), error: null }
    return { data: state.conv, error: null }
  }

  function builder(table: string) {
    const op: Op = {
      table,
      type: 'select',
      payload: {},
      filters: [],
      head: false,
      returning: false,
    }
    const b: Record<string, unknown> = {
      select: () => b,
      update: (p: Record<string, unknown>) => ((op.type = 'update'), (op.payload = p), b),
      eq: (k: string, v: unknown) => (op.filters.push(['eq', k, v]), b),
      is: (k: string, v: unknown) => (op.filters.push(['is', k, v]), b),
      gte: (k: string, v: unknown) => (op.filters.push(['gte', k, v]), b),
      maybeSingle: () => Promise.resolve(resolve(op)),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(op)).then(onF, onR),
    }
    return b
  }

  return {
    supabaseAdmin: () => ({
      from: (table: string) => builder(table),
      rpc: (name: string, args: unknown) => {
        state.rpcCalls.push({ name, args })
        return Promise.resolve({ data: state.claim, error: null })
      },
    }),
  }
})

import { dispatchInboundToAiReply, BURST_MAX_REPLIES } from './auto-reply'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
  inboundMessageId: 'wamid.inbound-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

const freshConv = (over: Record<string, unknown> = {}) => ({
  assigned_agent_id: null,
  ai_autoreply_disabled: false,
  ai_reply_count: 0,
  ...over,
})

/** The updates that carried a given payload key. */
const updatesWith = (key: string) => h.state.updates.filter((u) => key in u.payload)

beforeEach(() => {
  // The bot's per-account throttle is in-memory; reset it so the many
  // dispatches in this file never exhaust the 30/min bucket.
  __resetRateLimitForTests()
  h.state.convSeq = []
  h.state.conv = freshConv()
  h.state.claim = true
  h.state.rpcCalls = []
  h.state.agent = null
  h.state.subscription = 'opted_in'
  h.state.recentBotReplies = 0
  h.state.usageCount = 0
  h.state.claimWins = true
  h.state.updates = []
  h.state.order = []
  h.loadAiConfig.mockReset()
  h.generateReply.mockReset()
  h.engineSendText.mockReset()
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockImplementation(async () => {
    h.state.order.push('send')
    return { whatsapp_message_id: 'm1' }
  })
  h.loadAccountMetaCredentials.mockResolvedValue({
    phoneNumberId: 'pn-1',
    accessToken: 'tok',
  })
  h.sendTypingIndicator.mockResolvedValue(undefined)
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = freshConv({ assigned_agent_id: 'agent-9' })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = freshConv({ ai_autoreply_disabled: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('stays silent for an opted-out contact (e.g. they just sent STOP)', async () => {
    h.state.subscription = 'opted_out'
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updates).toHaveLength(0)
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })

  it('does not talk over a human who took the chat while the model was thinking', async () => {
    // First read (the gate) is clean; by the re-check the thread is assigned.
    h.state.convSeq = [freshConv(), freshConv({ assigned_agent_id: 'agent-9' })]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
  })

  it('does not talk over an agent who paused the bot while the model was thinking', async () => {
    h.state.convSeq = [freshConv(), freshConv({ ai_autoreply_disabled: true })]
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — reply cap (0 = unlimited)', () => {
  it('treats a cap of 0 as unlimited, even at a very high reply count', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyMaxPerConversation: 0 }))
    h.state.conv = freshConv({ ai_reply_count: 500 })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 0 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(h.state.updates).toHaveLength(0) // no handoff
  })

  it('hands the chat to a human when a finite cap is reached (not a silent stop)', async () => {
    h.state.conv = freshConv({ ai_reply_count: 3 })
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    const claim = updatesWith('ai_handoff_summary')[0]
    expect(claim.payload.ai_autoreply_disabled).toBe(true)
    expect(claim.payload.ai_handoff_summary).toContain('reply limit was reached')
    // Customer is told their chat went to the team.
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('our team') }),
    )
  })
})

describe('dispatchInboundToAiReply — burst guard (loop protection)', () => {
  it('pauses and hands off silently when the bot has replied too often too fast', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyMaxPerConversation: 0 }))
    h.state.recentBotReplies = BURST_MAX_REPLIES
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(updatesWith('ai_handoff_summary')[0].payload.ai_handoff_summary).toContain(
      'possible bot loop',
    )
    // No announcement: replying more would only feed a suspected loop.
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not trip below the threshold', async () => {
    h.state.recentBotReplies = BURST_MAX_REPLIES - 1
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })
})

describe('dispatchInboundToAiReply — typing indicator (#527)', () => {
  it('shows "typing…" on the inbound wamid before calling the LLM', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.loadAccountMetaCredentials).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
    )
    expect(h.sendTypingIndicator).toHaveBeenCalledTimes(1)
    expect(h.sendTypingIndicator).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok',
      messageId: 'wamid.inbound-1',
    })
    // Ordering: the indicator goes out while the customer waits on the
    // model, not after the reply is already generated.
    const typingOrder = h.sendTypingIndicator.mock.invocationCallOrder[0]
    const llmOrder = h.generateReply.mock.invocationCallOrder[0]
    expect(typingOrder).toBeLessThan(llmOrder)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('still sends the reply when the indicator request fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.sendTypingIndicator.mockRejectedValue(new Error('Meta API error: 400'))
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('typing indicator failed'),
      expect.any(Error),
    )
    warn.mockRestore()
  })

  it('still sends the reply when the WhatsApp credentials cannot be loaded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.loadAccountMetaCredentials.mockRejectedValue(
      new Error('WhatsApp not configured for this account'),
    )
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('skips the indicator when no inbound wamid is supplied', async () => {
    const { inboundMessageId: _omit, ...legacyArgs } = ARGS
    void _omit
    await dispatchInboundToAiReply(legacyArgs)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.loadAccountMetaCredentials).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('does not fire when a gate short-circuits before the LLM', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.loadAccountMetaCredentials).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  const agentRow = { user_id: 'agent-7', full_name: 'Riya Sharma' }

  it('model handoff with no agent configured: pauses, tells the customer the team has it, leaves it in the queue', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toHaveLength(0)
    const claim = updatesWith('ai_handoff_summary')[0]
    expect(claim.payload).toMatchObject({ ai_autoreply_disabled: true })
    expect(claim.payload.ai_handoff_summary).toContain('AI agent handed off')
    expect(updatesWith('assigned_agent_id')).toHaveLength(0)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('our team') }),
    )
  })

  it('names the agent in the notice, sends it BEFORE assigning, and assigns the chat', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.state.agent = agentRow
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)

    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        text: expect.stringContaining('Riya Sharma'),
        aiGenerated: true,
      }),
    )
    expect(h.state.order).toEqual(['claim', 'send', 'assign'])
    expect(updatesWith('assigned_agent_id')[0].payload).toEqual({
      assigned_agent_id: 'agent-7',
    })
    // A handoff does not consume an auto-reply slot.
    expect(h.state.rpcCalls).toHaveLength(0)
  })

  it("uses the model's own announcement (customer's language) when it names the agent", async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.state.agent = agentRow
    h.generateReply.mockResolvedValue({
      text: 'Riya Sharma ko aapki chat assign kar diya gaya hai, woh jald reply karengi.',
      handoff: true,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('jald reply karengi') }),
    )
    // The model was told the agent's name so it could announce them.
    expect(h.generateReply.mock.calls[0][0].systemPrompt).toContain('Riya Sharma')
  })

  it("falls back to the template when the model's announcement does not name the agent", async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.state.agent = agentRow
    h.generateReply.mockResolvedValue({
      text: 'Someone will be with you soon.',
      handoff: true,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "I've assigned Riya Sharma to your chat. They'll reply here shortly.",
      }),
    )
  })

  it('uses a generic name when the agent has no profile name', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.state.agent = { user_id: 'agent-7', full_name: '   ' }
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('our team') }),
    )
    expect(updatesWith('assigned_agent_id')[0].payload).toEqual({
      assigned_agent_id: 'agent-7',
    })
  })

  it('falls back to the shared queue when the configured agent left the account', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-gone' }))
    h.state.agent = null
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(updatesWith('assigned_agent_id')).toHaveLength(0)
    expect(updatesWith('ai_handoff_summary')).toHaveLength(1) // still paused
    warn.mockRestore()
  })

  it('still assigns the chat when the announcement fails to send', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.state.agent = agentRow
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    h.engineSendText.mockRejectedValue(new Error('outside 24h window'))
    await dispatchInboundToAiReply(ARGS)
    expect(updatesWith('assigned_agent_id')[0].payload).toEqual({
      assigned_agent_id: 'agent-7',
    })
    warn.mockRestore()
  })

  it('handles concurrent inbounds: only the claim winner announces and assigns', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.state.agent = agentRow
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    h.state.claimWins = false // another worker already took the handoff
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(updatesWith('assigned_agent_id')).toHaveLength(0)
  })

  it('never overwrites an existing assignment (assign is guarded by assigned_agent_id IS NULL)', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.state.agent = agentRow
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    const assign = updatesWith('assigned_agent_id')[0]
    expect(assign.filters).toContainEqual(['is', 'assigned_agent_id', null])
    const claim = updatesWith('ai_handoff_summary')[0]
    expect(claim.filters).toContainEqual(['is', 'assigned_agent_id', null])
    expect(claim.filters).toContainEqual(['eq', 'ai_autoreply_disabled', false])
  })

  it('treats an empty model answer (no text, no marker) as a handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: false })
    await dispatchInboundToAiReply(ARGS)
    expect(updatesWith('ai_handoff_summary')).toHaveLength(1)
  })
})

describe('dispatchInboundToAiReply — customer asks for a human', () => {
  const agentRow = { user_id: 'agent-7', full_name: 'Riya Sharma' }

  beforeEach(() => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.state.agent = agentRow
  })

  it('hands off without answering, even if the model would have replied', async () => {
    h.buildConversationContext.mockResolvedValue([
      { role: 'user', content: 'mujhe agent se baat karni hai' },
    ])
    // The only model call is the one-line announcement, not an answer.
    h.generateReply.mockResolvedValue({
      text: 'Riya Sharma ko aapki chat assign kar di gayi hai.',
      handoff: false,
    })
    await dispatchInboundToAiReply(ARGS)

    expect(h.retrieveKnowledge).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Riya Sharma') }),
    )
    expect(h.state.order).toEqual(['claim', 'send', 'assign'])
    expect(updatesWith('ai_handoff_summary')[0].payload.ai_handoff_summary).toContain(
      'customer asked for a human',
    )
  })

  it('uses the fixed template if the announcement call fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.buildConversationContext.mockResolvedValue([
      { role: 'user', content: 'I want to talk to a human' },
    ])
    h.generateReply.mockRejectedValue(new Error('provider down'))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "I've assigned Riya Sharma to your chat. They'll reply here shortly.",
      }),
    )
    expect(updatesWith('assigned_agent_id')).toHaveLength(1)
    warn.mockRestore()
  })

  it('does not assign when the thread is already owned by a human', async () => {
    h.state.conv = freshConv({ assigned_agent_id: 'agent-9' })
    h.buildConversationContext.mockResolvedValue([
      { role: 'user', content: 'connect me to an agent' },
    ])
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updates).toHaveLength(0)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not trigger on an ordinary message', async () => {
    h.buildConversationContext.mockResolvedValue([
      { role: 'user', content: 'I am a travel agent, what are your prices?' },
    ])
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updates).toHaveLength(0)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello!' }),
    )
  })
})

describe('dispatchInboundToAiReply — thread isolation', () => {
  it('every write is filtered on THIS conversation id and nothing broader', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.state.agent = { user_id: 'agent-7', full_name: 'Riya Sharma' }
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updates.length).toBeGreaterThan(0)
    for (const u of h.state.updates) {
      expect(u.table).toBe('conversations')
      expect(u.filters).toContainEqual(['eq', 'id', 'conv-1'])
      expect(u.filters).toContainEqual(['eq', 'account_id', 'acct-1'])
    }
  })

  it("another thread's pause/cap state is never consulted — this thread still replies", async () => {
    h.state.conv = freshConv() // this thread is clean
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })
})

describe('dispatchInboundToAiReply — after a handoff the bot stays out', () => {
  it('the very next inbound is silent (handoff is sticky, assignment owns the thread)', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.state.agent = { user_id: 'agent-7', full_name: 'Riya Sharma', account_role: 'agent' }
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1) // the announcement

    h.engineSendText.mockClear()
    h.generateReply.mockClear()
    h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
    await dispatchInboundToAiReply(ARGS) // customer writes again
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('also silent after a queue handoff (no agent): the pause flag alone holds', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    h.engineSendText.mockClear()
    h.generateReply.mockClear()
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — provider failure is never silent', () => {
  it('hands the chat to a human, records the cause, and does not retry', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.state.agent = { user_id: 'agent-7', full_name: 'Riya Sharma', account_role: 'agent' }
    h.generateReply.mockRejectedValue(Object.assign(new Error('rejected'), { code: 'invalid_key' }))
    await dispatchInboundToAiReply(ARGS)

    expect(h.generateReply).toHaveBeenCalledTimes(1) // no retry
    const note = updatesWith('ai_handoff_summary')[0].payload.ai_handoff_summary as string
    expect(note).toContain('AI service was unavailable')
    expect(note).toContain('[invalid_key]')
    expect(h.state.rpcCalls).toHaveLength(0) // no AI reply slot consumed
    expect(h.state.order).toEqual(['claim', 'send', 'assign'])
    err.mockRestore()
  })

  it('works with no agent configured too (shared queue + generic notice)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.generateReply.mockRejectedValue(new Error('network'))
    await dispatchInboundToAiReply(ARGS)
    expect(updatesWith('assigned_agent_id')).toHaveLength(0)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('our team') }),
    )
    err.mockRestore()
  })
})

describe('dispatchInboundToAiReply — handoff agent must be able to handle chats', () => {
  it('does not assign a viewer (read-only) — falls back to the shared queue', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.state.agent = { user_id: 'agent-7', full_name: 'Vik', account_role: 'viewer' }
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(updatesWith('assigned_agent_id')).toHaveLength(0)
    expect(updatesWith('ai_handoff_summary')).toHaveLength(1)
    warn.mockRestore()
  })

  it('accepts owner / admin / agent roles', async () => {
    for (const role of ['owner', 'admin', 'agent']) {
      h.state.updates = []
      h.state.conv = freshConv()
      h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
      h.state.agent = { user_id: 'agent-7', full_name: 'Riya', account_role: role }
      h.generateReply.mockResolvedValue({ text: '', handoff: true })
      await dispatchInboundToAiReply(ARGS)
      expect(updatesWith('assigned_agent_id')).toHaveLength(1)
    }
  })
})

describe('dispatchInboundToAiReply — shared (cross-instance) account budget', () => {
  it('skips the reply when the account is over its per-minute AI budget', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.state.usageCount = 30
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('replies normally under the budget', async () => {
    h.state.usageCount = 29
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })
})