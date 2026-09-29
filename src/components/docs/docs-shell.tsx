'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowLeft, Menu, X } from 'lucide-react';

import type { NavGroup } from '@/lib/docs/content';
import { useActiveHeading } from '@/components/docs/use-active-heading';
import { cn } from '@/lib/utils';

function SidebarNav({ nav, onNavigate }: { nav: NavGroup[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  // Match the most specific href first (every other doc's href starts
  // with '/docs', so checking them before the 'reference' group at
  // '/docs' itself is what makes this a correct longest-prefix match
  // instead of always landing on 'reference'). Falls back to
  // 'reference' for the docs home page and any unrecognized path.
  const currentKey =
    nav.find((g) => g.href !== '/docs' && pathname.startsWith(g.href))?.key ?? 'reference';
  const current = nav.find((g) => g.key === currentKey);
  const active = useActiveHeading((current?.sections ?? []).map((s) => s.id));

  return (
    <nav aria-label="Documentation" className="space-y-6 text-sm">
      {nav.map((group) => {
        const isCurrent = group.key === currentKey;
        // Section links stay on the page you are reading (also for the
        // per-campaign page, whose URL carries the campaign id).
        const base = isCurrent ? pathname : group.href;
        return (
          <div key={group.key}>
            <Link
              href={group.href}
              onClick={onNavigate}
              className={cn(
                'block px-2 py-1 text-xs font-semibold uppercase tracking-wide',
                isCurrent ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {group.label}
            </Link>
            <ul className="mt-1 space-y-0.5">
              {group.sections.map((s) => (
                <li key={s.id}>
                  <Link
                    href={`${base}#${s.id}`}
                    onClick={onNavigate}
                    className={cn(
                      'block rounded-md px-2 py-1.5 transition-colors',
                      isCurrent && active === s.id
                        ? 'bg-primary/10 font-medium text-primary'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    {s.text}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

export function DocsShell({ nav, children }: { nav: NavGroup[]; children: React.ReactNode }) {
  // The drawer closes via each link's onNavigate (see SidebarNav).
  const [open, setOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur lg:px-6">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open documentation menu"
          className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
        >
          <Menu className="size-5" />
        </button>
        <Link href="/docs" className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/innovatex-mark.png" alt="" width={28} height={28} className="h-7 w-7 object-contain" />
          <span className="text-sm font-semibold">InnovateX Docs</span>
        </Link>
        <Link
          href="/dashboard"
          className="ml-auto inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to dashboard
        </Link>
      </header>

      <div className="mx-auto flex max-w-[1440px]">
        <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-64 shrink-0 overflow-y-auto border-r border-border p-4 lg:block">
          <SidebarNav nav={nav} />
        </aside>
        <main className="min-w-0 flex-1">{children}</main>
      </div>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close documentation menu"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-background/70 backdrop-blur-sm"
          />
          <div className="absolute inset-y-0 left-0 w-72 overflow-y-auto border-r border-border bg-card p-4">
            <div className="mb-4 flex items-center justify-between">
              <span className="text-sm font-semibold">Documentation</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
              >
                <X className="size-4" />
              </button>
            </div>
            <SidebarNav nav={nav} onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}
    </div>
  );
}