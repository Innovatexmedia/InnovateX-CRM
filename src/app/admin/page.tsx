import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { requirePlatformAdmin, NotPlatformAdminError } from '@/lib/admin/auth'
import { AdminAccountsClient } from './admin-accounts-client'

// Same "don't index" belt-and-suspenders as the (dashboard) layout —
// this is an even more sensitive surface (cross-tenant data), so it
// gets the same treatment even though it sits outside that route
// group.
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
}

/**
 * Platform-admin dashboard: every account on the deployment, with
 * approve/suspend controls and the "how many users" head-count.
 * Gated server-side by requirePlatformAdmin() (fixed email
 * allowlist, see src/lib/admin/auth.ts) — anyone else hitting
 * /admin bounces to /login before any admin-only data is fetched,
 * let alone rendered.
 */
export default async function AdminPage() {
  try {
    await requirePlatformAdmin()
  } catch (err) {
    if (err instanceof NotPlatformAdminError) {
      redirect('/login')
    }
    throw err
  }

  return (
    <div className="mx-auto min-h-screen max-w-5xl px-6 py-10">
      <AdminAccountsClient />
    </div>
  )
}