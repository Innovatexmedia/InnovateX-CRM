'use client'

import { useRouter } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'

/**
 * Shown by middleware.ts to a signed-in user whose account is
 * `suspended` in accounts.approval_status (migration 047). See
 * /account-pending for the sibling "never approved yet" state, and
 * its comment for why signOut is done directly against Supabase
 * here rather than via the useAuth() hook (its <AuthProvider> only
 * wraps the (dashboard) route group).
 */
export default function AccountSuspendedPage() {
  const router = useRouter()
  const signOut = async () => {
    await createClient().auth.signOut()
    router.push('/login')
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="max-w-md space-y-4 text-center">
        <h1 className="text-xl font-semibold">Your account has been suspended</h1>
        <p className="text-muted-foreground text-sm">
          Access to this account has been paused. If you believe this is a
          mistake, contact your InnovateX admin.
        </p>
        <Button variant="outline" onClick={() => signOut()}>
          Sign out
        </Button>
      </div>
    </div>
  )
}