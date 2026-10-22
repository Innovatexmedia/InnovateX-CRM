'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CalendarDays, Loader2, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { GatedButton } from '@/components/ui/gated-button';
import { useCan } from '@/hooks/use-can';
import { CAMPAIGN_STATUS_STYLE } from '@/components/events/status';
import { formatEventDateTime } from '@/lib/events/schedule';
import type { EventCampaignRow, EventReminderRow } from '@/lib/events/types';

type Row = EventCampaignRow & { event_reminders: Pick<EventReminderRow, 'id' | 'status'>[] };

export default function EventCampaignsPage() {
  const t = useTranslations('EventCampaign');
  const router = useRouter();
  const canCreate = useCan('send-messages');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error: err } = await createClient()
        .from('event_campaigns')
        .select('*, event_reminders(id, status)')
        .order('event_at', { ascending: false });
      if (cancelled) return;
      if (err) setError(err.message);
      else setRows((data ?? []) as Row[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('list.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('list.subtitle')}</p>
        </div>
        <GatedButton
          canAct={canCreate}
          gateReason="create event campaigns"
          onClick={() => router.push('/broadcasts/events/new')}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          {t('list.newEvent')}
        </GatedButton>
      </div>

      {error ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : rows === null ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : rows.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-border bg-card text-center">
          <CalendarDays className="mb-3 h-10 w-10 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">{t('list.empty')}</p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">{t('list.emptyHint')}</p>
        </div>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {rows.map((r) => {
            const sent = r.event_reminders.filter((x) => x.status === 'queued').length;
            return (
              <Link
                key={r.id}
                href={`/broadcasts/events/${r.id}`}
                className="flex flex-wrap items-center justify-between gap-3 p-4 transition-colors hover:bg-muted/40"
              >
                <div className="min-w-0">
                  <p className="truncate font-semibold text-foreground">{r.name}</p>
                  <p className="text-xs text-muted-foreground">{formatEventDateTime(new Date(r.event_at))} IST</p>
                </div>
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <span>{t('list.remindersSent', { sent, total: r.event_reminders.length })}</span>
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${CAMPAIGN_STATUS_STYLE[r.status]}`}>
                    {t(`status.${r.status}`)}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}