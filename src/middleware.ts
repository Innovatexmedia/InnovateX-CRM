import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // getUser() transparently refreshes an expired access token, which
  // ROTATES the refresh token and writes the new cookies onto
  // `supabaseResponse` via setAll() above. Any response we return in
  // place of `supabaseResponse` (every redirect / JSON branch below)
  // is a fresh object that does NOT carry those Set-Cookie headers, so
  // the rotated token never reaches the browser. The next request then
  // replays the old, now-consumed refresh token, the refresh fails, and
  // the session wedges — the user gets a broken reload after idling and
  // can only recover by manually clearing cookies (issue #288). Copy the
  // refreshed cookies onto whatever response we hand back to fix that.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie)
    })
    return response
  }

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (user && (
    request.nextUrl.pathname === '/login' ||
    request.nextUrl.pathname === '/signup' ||
    request.nextUrl.pathname === '/forgot-password'
  )) {
    const url = request.nextUrl.clone()
    const inviteToken = request.nextUrl.searchParams.get('invite')
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' ||
        request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
    } else {
      url.pathname = '/dashboard'
      url.search = ''
    }
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // Protected pages - redirect to login if not authenticated
  const protectedPaths = ['/dashboard', '/inbox', '/contacts', '/pipelines', '/broadcasts', '/automations', '/settings', '/docs']
  if (!user && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // API routes that need auth (not webhooks)
  if (!user && request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
      !request.nextUrl.pathname.includes('/webhook')) {
    return withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
  }

  // Account approval gate (migration 047). A signed-in user whose
  // account is `pending` (new signup, not yet approved by a
  // platform admin) or `suspended` gets bounced off every
  // protected page and dashboard-scoped API route to a dedicated
  // status page, rather than reaching the dashboard shell and
  // having every individual fetch 401/403 piecemeal.
  //
  // /admin and /api/admin/* are excluded deliberately: they carry
  // their own gate (requirePlatformAdmin, a fixed email allowlist —
  // see src/lib/admin/auth.ts) that has nothing to do with the
  // caller's own account status, and a platform admin must be able
  // to reach /admin even in the edge case their own account row
  // were ever anything but approved.
  const approvalGatedPaths = [...protectedPaths, '/api/whatsapp/', '/api/account/', '/api/automations/', '/api/broadcasts/', '/api/contacts/', '/api/conversations/', '/api/flows/', '/api/ai/']
  const isStatusPage =
    request.nextUrl.pathname === '/account-pending' ||
    request.nextUrl.pathname === '/account-suspended'
  const isAdminSurface = request.nextUrl.pathname.startsWith('/admin') ||
    request.nextUrl.pathname.startsWith('/api/admin')

  if (
    user &&
    !isStatusPage &&
    !isAdminSurface &&
    approvalGatedPaths.some((path) => request.nextUrl.pathname.startsWith(path))
  ) {
    // Two round trips (profiles -> account_id, then accounts by id)
    // rather than an embedded FK join (`profiles.select('accounts(...)')`).
    // The embed forces PostgREST to resolve the profiles.account_id ->
    // accounts.id relationship from its schema cache; right after a
    // migration adds/changes that relationship the cache can be stale,
    // the embed fails with PGRST200 ("could not find a relationship in
    // the schema cache"), and — since that error was silently swallowed
    // here — approvalStatus fell through to undefined, which is neither
    // 'pending' nor 'suspended', so the gate let pending/suspended users
    // straight through. Same failure mode already documented against
    // getCurrentAccount() in src/lib/auth/account.ts (issue #294); this
    // mirrors that fix. A plain by-id lookup needs no relationship
    // inference and is gated by the same accounts RLS.
    const { data: profileRow } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()

    let approvalStatus: string | undefined
    if (profileRow?.account_id) {
      const { data: accountRow } = await supabase
        .from('accounts')
        .select('approval_status')
        .eq('id', profileRow.account_id)
        .maybeSingle()
      approvalStatus = accountRow?.approval_status
    }

    if (approvalStatus === 'pending' || approvalStatus === 'suspended') {
      const isApiRoute = request.nextUrl.pathname.startsWith('/api/')
      if (isApiRoute) {
        return withRefreshedCookies(
          NextResponse.json(
            { error: approvalStatus === 'pending' ? 'Account pending approval' : 'Account suspended' },
            { status: 403 },
          ),
        )
      }
      const url = request.nextUrl.clone()
      url.pathname = approvalStatus === 'pending' ? '/account-pending' : '/account-suspended'
      url.search = ''
      return withRefreshedCookies(NextResponse.redirect(url))
    }
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}