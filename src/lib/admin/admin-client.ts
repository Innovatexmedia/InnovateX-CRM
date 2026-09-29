import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client for the platform-admin surface
// (/admin + /api/admin/*). Mirrors the pattern used elsewhere in
// this codebase (src/lib/automations/admin-client.ts,
// src/lib/ai/admin-client.ts, src/lib/flows/admin-client.ts) —
// each domain keeps its own instance rather than sharing one
// module, so a change to one admin surface's needs never risks
// another's.
//
// This client bypasses RLS entirely (service-role key), which is
// required here: the whole point of /admin is reading and mutating
// OTHER accounts' rows, which no account-scoped RLS policy would
// ever allow a normal member to do. Every call site MUST gate on
// requirePlatformAdmin() (src/lib/admin/auth.ts) before touching
// this client — it is not safe to use from a route that hasn't
// checked the caller's email against PLATFORM_ADMIN_EMAILS first.
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}