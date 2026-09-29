# AI Assistant

The AI Assistant is bring-your-own-key (OpenAI, Anthropic, or Gemini) and powers two separate things in the inbox: **Draft with AI** (an agent clicks it, reviews the suggestion, edits, and sends) and **Auto-reply** (the bot answers inbound WhatsApp messages on its own, with no click). This page explains exactly when each one runs — and, more importantly, when it silently does *not* — so a quiet bot never looks like a broken one.

## Draft with AI

Any agent can click the ✨ icon in the composer on any conversation, assigned or not, to get a suggested reply. It never sends on its own — you always review and send it yourself. This is unaffected by everything below; the rules on this page are specific to **Auto-reply**.

## Auto-reply — when it runs

Auto-reply answers a fresh inbound message automatically only when **every** condition below is true. It's an "AND", not an "OR" — the first one that fails silences the bot for that message, with no error shown anywhere:

1. **Enable AI assistant** and **Auto-reply to inbound messages** are both on, and saved (Settings → AI Assistant).
2. **No conversation-level flow already handled the message.** A deterministic Flow (built in the Flows tab) always wins over the LLM.
3. **No responder Automation (`New message received` or `Keyword match` trigger) matched and ran for *this* inbound message.** This is per-message, the same waterfall Flows use: a `Keyword match` automation only stands the bot down for a message that actually hit one of its keywords, so it runs fine alongside auto-reply the rest of the time. `New message received` has no filter — it matches every inbound — so an active one means the bot never fires, at all, until it's turned off. Settings shows a warning for that specific case — see below.
4. **No human agent is assigned to the conversation.** The moment someone is assigned (manually, or by a prior AI handoff), the bot stands down for that thread. This is deliberate: an assigned thread has a human owner, and the bot never talks over them.
5. **Auto-reply hasn't been paused on this specific conversation.** A pause happens either because an agent clicked "Take over" in the inbox, or because the bot itself handed off (see below). A conversation banner shows "Resume AI" whenever this is the reason.
6. **The per-conversation reply cap (Settings → Max auto-replies per conversation) hasn't been hit.**

## Why the bot sometimes hands off without answering

Even when every condition above is met, the model itself can decide a message needs a human — a genuine complaint, a refund/payment dispute, or a request needing account-specific detail it can't verify. When that happens, the bot pauses **itself** on that one conversation and leaves a short note (visible in the inbox banner) — this is expected behavior, not a bug. Click **Resume AI** on that conversation to hand it back to the bot; the next matching message will be answered automatically again.

If the bot hands off far more often than expected, the usual cause is the system prompt (Settings → AI Assistant → Business context & instructions) being too broad about when to hand off — for example, phrasing that reads "any question I'm unsure about" rather than a specific, narrow list of situations.

## Automations and the AI bot — how they share a conversation

Automations and Auto-reply run as a waterfall on every inbound message, same as Flows: deterministic responders get first look, and the AI bot only answers what nothing else caught. Concretely, per message:

1. A `Keyword match` automation whose keywords match this message runs — the bot stays silent, but only for this one message.
2. Otherwise, a `New message received` automation (if active) runs — it matches everything, so if you have one of these active, the bot effectively never gets a turn.
3. Otherwise, if nothing matched, Auto-reply answers.

So a `Keyword match` automation for, say, the word "refund" coexists with the AI bot fine: messages containing "refund" go to the automation, everything else goes to the AI. A `New message received` automation is different — because it has no filter, running one alongside Auto-reply means Auto-reply is configured but will never actually speak. Settings → AI Assistant shows a warning banner for that specific case (an active `New message received` automation), so you don't have to go check the Automations tab to explain a silent bot.