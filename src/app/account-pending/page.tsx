'use client'

import { useRouter } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'

/**
 * Shown by middleware.ts to a signed-in user whose account is still
 * `pending` in accounts.approval_status (migration 047) — i.e. they
 * verified their email but no platform admin has approved the
 * account yet. Every dashboard/API route stays blocked until then;
 * this page (and /account-suspended) are the two escape hatches the
 * middleware allow-lists so a gated user can still see why and sign
 * out.
 *
 * Deliberately does NOT use the `useAuth()` hook's signOut — that
 * hook's <AuthProvider> only wraps the (dashboard) route group
 * (see dashboard-shell.tsx), so outside it useAuth() falls back to
 * a stub that just redirects without touching the Supabase session.
 * This page calls supabase.auth.signOut() directly so the session
 * cookie is actually cleared, not just navigated away from.
 */
export default function AccountPendingPage() {
  const router = useRouter()
  const signOut = async () => {
    await createClient().auth.signOut()
    router.push('/login')
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="max-w-md space-y-4 text-center">
        <h1 className="text-xl font-semibold">Your account is awaiting approval</h1>
        <p className="text-muted-foreground text-sm">
          Thanks for signing up. An InnovateX admin needs to approve your
          account before you can log in — this is usually quick. Check back
          shortly, or reach out if it&apos;s been a while.
        </p>
        <Button variant="outline" onClick={() => signOut()}>
          Sign out
        </Button>
      </div>
    </div>
  )
}