# InnovateX CRM — WhatsApp CRM by InnovateX Media

> A WhatsApp-first CRM — shared inbox, contacts, sales pipelines,
> broadcasts, and no-code automations, built and run by InnovateX Media.

## What you get

- **Shared inbox** on the official WhatsApp Business API — multiple
  agents working one number, per-conversation assignment, status, and
  notes.
- **Contacts + tags + custom fields**, CSV import, deduplication.
- **Opt-in / opt-out management** — configurable keywords, quick-reply
  triggers, per-account auto-responses, and automatic exclusion of
  opted-out contacts from broadcasts and automations.
- **Sales pipelines** (Kanban) with deals linked to conversations.
- **Broadcasts** with Meta-approved templates, delivery + read
  tracking, per-recipient variable substitution, and scheduling.
- **API Campaigns** — create a campaign once in the dashboard, then
  trigger it per-recipient from your own systems via
  `POST /api/v1/campaigns/{id}/send`.
- **No-code automations** — triggers on inbound messages, new
  contacts, keywords, or schedule; conditional branches, waits,
  tags, webhooks. Visual builder.
- **AI reply assistant** — one-click AI-drafted replies in the inbox,
  plus an optional auto-reply bot with a per-conversation cap and
  clean human handoff. Add a knowledge base (FAQs, policies, product
  docs) and it answers from your own content.
- **Real-time dashboard** — response times, daily volume, pipeline
  value, cross-module activity feed.
- **Team accounts** — invite teammates by link, role-based access
  (owner / admin / agent / viewer), ownership transfer.
- **Account management** — email, password, avatar, global sign-out.
- **Public REST API** (`/api/v1`) with scoped, revocable API keys —
  build your own automations on top of the CRM. See
  [docs/public-api.md](./docs/public-api.md).
- **MCP server** — drive the CRM from Claude, Cursor, and other AI
  assistants over the Model Context Protocol. Read-only by default,
  opt-in writes. See [docs/mcp.md](./docs/mcp.md)
  (server in [`mcp-server/`](./mcp-server)).

## Stack

- **App** — Next.js 16 (App Router), React 19, TypeScript, Tailwind v4.
- **Data** — Supabase (Postgres + Auth + Storage + RLS).
- **WhatsApp** — Meta Cloud API (official WhatsApp Business API).

## Environments

- WhatsApp CRM: `chats.innovatexmedia.com`
- Full OS dashboard: `dashboard.innovatexmedia.com`

## Local development

```bash
git clone <this-repo>
cd innovatex-crm
npm install
cp .env.local.example .env.local   # fill in Supabase + Meta creds
npm run dev
```

Open <http://localhost:3000>. You'll be redirected to `/login` (or
`/dashboard` if already signed in).

The UI ships in English, Korean, Brazilian Portuguese and Spanish — set
`NEXT_PUBLIC_APP_LOCALE` to `en`, `ko`, `pt` or `es` in `.env.local`
(catalogues live in `messages/`).

## Documentation

- [Public API](./docs/public-api.md)
- [MCP server](./docs/mcp.md)
- [WhatsApp connection troubleshooting](./docs/whatsapp-connection-troubleshooting.md)
- [Several WABAs on one deployment](./docs/multi-waba.md)

## License

Internal — InnovateX Media. Not for redistribution.
