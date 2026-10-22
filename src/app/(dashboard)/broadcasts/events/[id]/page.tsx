'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, Loader2, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useCan } from '@/hooks/use-can';
import {
  ReminderEditor,
  draftOffset,
  draftProblem,
  draftToInput,
  newDraft,
  useEventFormData,
  type ReminderDraft,
} from '@/components/events/reminder-editor';
import { CAMPAIGN_STATUS_STYLE, REMINDER_STATUS_STYLE } from '@/components/events/status';
import {
  dateToIstInputs,
  formatEventDateTime,
  istToDate,
  offsetLabel,
  planReminder,
} from '@/lib/events/schedule';
import { eventContextOf } from '@/lib/events/context';
import type { EventCampaignRow, EventReminderRow } from '@/lib/events/types';

interface BroadcastCounts {
  id: string;
  total_recipients: number | null;
  sent_count: number | null;
  delivered_count: number | null;
  read_count: number | null;
  failed_count: number | null;
}

const inputClass =
  'h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

export default function EventCampaignDetailPage() {
  const t = useTranslations('EventCampaign');
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const canEdit = useCan('send-messages');
  const data = useEventFormData();

  const [campaign, setCampaign] = useState<EventCampaignRow | null>(null);
  const [reminders, setReminders] = useState<EventReminderRow[]>([]);
  const [counts, setCounts] = useState<Map<string, BroadcastCounts>>(new Map());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [confirming, setConfirming] = useState<'cancel' | 'delete' | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    const [c, r] = await Promise.all([
      supabase.from('event_campaigns').select('*').eq('id', id).maybeSingle(),
      supabase.from('event_reminders').select('*').eq('event_campaign_id', id).order('offset_minutes', { ascending: true }),
    ]);
    setCampaign((c.data as EventCampaignRow | null) ?? null);
    const rows = (r.data ?? []) as EventReminderRow[];
    setReminders(rows);
    const ids = rows.map((x) => x.broadcast_id).filter((x): x is string => !!x);
    if (ids.length > 0) {
      const { data: b } = await supabase
        .from('broadcasts')
        .select('id, total_recipients, sent_count, delivered_count, read_count, failed_count')
        .in('id', ids);
      setCounts(new Map(((b ?? []) as BroadcastCounts[]).map((x) => [x.id, x])));
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function call(url: string, init: RequestInit, okMessage?: string): Promise<boolean> {
    setBusy(true);
    try {
      const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json' } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || t('errorGeneric'));
      if (okMessage) toast.success(okMessage);
      await load();
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('errorGeneric'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const patch = (payload: Record<string, unknown>, ok?: string) =>
    call(`/api/events/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }, ok);

  async function remove() {
    setConfirming(null);
    setBusy(true);
    const res = await fetch(`/api/events/${id}`, { method: 'DELETE' });
    if (res.ok) {
      router.push('/broadcasts/events');
      return;
    }
    const body = await res.json().catch(() => ({}));
    toast.error(body.error || t('errorGeneric'));
    setBusy(false);
  }

  const tagNames = useMemo(() => {
    const byId = new Map(data.tags.map((x) => [x.id, x.name]));
    const names = (ids: string[]) => ids.map((i) => byId.get(i)).filter(Boolean).join(', ');
    return { include: names(campaign?.audience_tag_ids ?? []), exclude: names(campaign?.exclude_tag_ids ?? []) };
  }, [data.tags, campaign]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }
  if (!campaign) {
    return <p className="p-6 text-sm text-muted-foreground">{t('detail.notFound')}</p>;
  }

  const finished = campaign.status === 'cancelled' || campaign.status === 'completed';

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <Link href="/broadcasts/events" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> {t('detail.back')}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-bold text-foreground">{campaign.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{formatEventDateTime(new Date(campaign.event_at))} IST</p>
          <span className={`mt-2 inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${CAMPAIGN_STATUS_STYLE[campaign.status]}`}>
            {t(`status.${campaign.status}`)}
          </span>
        </div>
        {canEdit && !finished && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setEditOpen(true)}>
              {t('detail.editEvent')}
            </Button>
            {campaign.status === 'active' ? (
              <Button variant="outline" disabled={busy} onClick={() => patch({ action: 'pause' }, t('detail.paused'))}>
                {t('detail.pause')}
              </Button>
            ) : (
              <Button variant="outline" disabled={busy} onClick={() => patch({ action: 'resume' }, t('detail.resumed'))}>
                {t('detail.resume')}
              </Button>
            )}
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => setConfirming('cancel')}
            >
              {t('detail.cancel')}
            </Button>
          </div>
        )}
        {canEdit && finished && (
          <Button variant="destructive" disabled={busy} onClick={() => setConfirming('delete')}>
            {t('detail.delete')}
          </Button>
        )}
      </div>

      {campaign.status === 'paused' && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">{t('detail.pausedBanner')}</p>
      )}

      <div className="grid gap-3 rounded-xl border border-border bg-card p-5 text-sm sm:grid-cols-2">
        <Info label={t('detail.audience')} value={tagNames.include || '—'} sub={tagNames.exclude ? t('review.tagsExclude', { tags: tagNames.exclude }) : undefined} />
        <Info
          label={t('detail.quiet')}
          value={campaign.quiet_enabled ? `${campaign.quiet_from} – ${campaign.quiet_to} IST` : t('reminders.quietOff')}
        />
        {campaign.location && <Info label={t('event.location')} value={campaign.location} />}
        {campaign.join_link && <Info label={t('event.joinLink')} value={campaign.join_link} />}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">{t('detail.reminders')}</h2>
          {canEdit && !finished && (
            <Button variant="outline" disabled={busy} onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4" /> {t('detail.addReminder')}
            </Button>
          )}
        </div>

        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {reminders.map((r) => {
            const c = r.broadcast_id ? counts.get(r.broadcast_id) : undefined;
            const removable = canEdit && ['scheduled', 'skipped', 'failed'].includes(r.status);
            return (
              <div key={r.id} className="space-y-2 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-foreground">{offsetLabel(r.offset_minutes)}</p>
                    <p className="truncate text-xs text-muted-foreground">{r.template_name}</p>
                  </div>
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${REMINDER_STATUS_STYLE[r.status]}`}>
                    {r.status === 'skipped' && r.skip_reason ? t(`detail.skip.${r.skip_reason}`) : t(`detail.reminderStatus.${r.status}`)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    {r.send_at ? formatEventDateTime(new Date(r.send_at)) : '—'}
                    {r.moved_by_quiet_hours && r.send_at ? ` · ${t('reminders.movedQuiet')}` : ''}
                  </span>
                  <span className="flex items-center gap-3">
                    {c && (
                      <span>
                        {t('detail.counts', {
                          sent: c.sent_count ?? 0,
                          delivered: c.delivered_count ?? 0,
                          read: c.read_count ?? 0,
                          failed: c.failed_count ?? 0,
                        })}
                      </span>
                    )}
                    {r.broadcast_id && (
                      <Link href={`/broadcasts/${r.broadcast_id}`} className="text-primary hover:underline">
                        {t('detail.viewReport')}
                      </Link>
                    )}
                    {removable && (
                      <button
                        type="button"
                        disabled={busy}
                        className="text-red-400 hover:underline"
                        onClick={() => call(`/api/events/${id}/reminders/${r.id}`, { method: 'DELETE' }, t('detail.reminderRemoved'))}
                      >
                        {t('reminders.removeShort')}
                      </button>
                    )}
                  </span>
                </div>
                {r.error_message && <p className="text-xs text-red-400">{r.error_message}</p>}
              </div>
            );
          })}
          {reminders.length === 0 && <p className="p-4 text-sm text-muted-foreground">{t('detail.noReminders')}</p>}
        </div>
      </div>

      <Dialog open={confirming !== null} onOpenChange={(o) => !o && setConfirming(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{confirming === 'delete' ? t('detail.delete') : t('detail.cancel')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {confirming === 'delete' ? t('detail.confirmDelete') : t('detail.confirmCancel')}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirming(null)}>
              {t('detail.close')}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                if (confirming === 'delete') {
                  await remove();
                } else {
                  setConfirming(null);
                  await patch({ action: 'cancel' }, t('detail.cancelled'));
                }
              }}
            >
              {confirming === 'delete' ? t('detail.delete') : t('detail.cancel')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {editOpen && (
      <EditEventDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        campaign={campaign}
        busy={busy}
        onSave={async (payload) => {
          const ok = await patch({ action: 'update', ...payload }, t('detail.saved'));
          if (ok) setEditOpen(false);
        }}
      />
      )}

      {addOpen && (
      <AddReminderDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        campaign={campaign}
        data={data}
        busy={busy}
        onAdd={async (d) => {
          const ok = await call(
            `/api/events/${id}/reminders`,
            { method: 'POST', body: JSON.stringify(draftToInput(d)) },
            t('detail.reminderAdded'),
          );
          if (ok) setAddOpen(false);
        }}
      />
      )}
    </div>
  );
}

function Info({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="truncate text-foreground" title={value}>
        {value}
      </p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function EditEventDialog({
  open,
  onOpenChange,
  campaign,
  busy,
  onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  campaign: EventCampaignRow;
  busy: boolean;
  onSave: (payload: Record<string, unknown>) => void;
}) {
  const t = useTranslations('EventCampaign');
  const initial = dateToIstInputs(new Date(campaign.event_at));
  const [name, setName] = useState(campaign.name);
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [location, setLocation] = useState(campaign.location ?? '');
  const [joinLink, setJoinLink] = useState(campaign.join_link ?? '');
  const [quietEnabled, setQuietEnabled] = useState(campaign.quiet_enabled);
  const [quietFrom, setQuietFrom] = useState(campaign.quiet_from);
  const [quietTo, setQuietTo] = useState(campaign.quiet_to);

  const at = istToDate(date, time);
  const moved = at && at.getTime() !== new Date(campaign.event_at).getTime();
  const quietChanged =
    quietEnabled !== campaign.quiet_enabled || quietFrom !== campaign.quiet_from || quietTo !== campaign.quiet_to;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('detail.editEvent')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block space-y-1 text-sm text-muted-foreground">
            {t('event.name')}
            <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} className={inputClass} />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1 text-sm text-muted-foreground">
              {t('event.date')}
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputClass} />
            </label>
            <label className="block space-y-1 text-sm text-muted-foreground">
              {t('event.time')}
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={inputClass} />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">{t('event.istNote')}</p>
          {moved && <p className="text-xs text-amber-400">{t('detail.retimeNote')}</p>}
          <label className="block space-y-1 text-sm text-muted-foreground">
            {t('event.location')}
            <input value={location} onChange={(e) => setLocation(e.target.value)} className={inputClass} />
          </label>
          <label className="block space-y-1 text-sm text-muted-foreground">
            {t('event.joinLink')}
            <input value={joinLink} placeholder="https://" onChange={(e) => setJoinLink(e.target.value)} className={inputClass} />
          </label>
          <div className="space-y-2 rounded-lg border border-border p-3">
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input type="checkbox" checked={quietEnabled} onChange={(e) => setQuietEnabled(e.target.checked)} />
              {t('reminders.quietTitle')}
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <input type="time" value={quietFrom} disabled={!quietEnabled} onChange={(e) => e.target.value && setQuietFrom(e.target.value)} className={inputClass} />
              <input type="time" value={quietTo} disabled={!quietEnabled} onChange={(e) => e.target.value && setQuietTo(e.target.value)} className={inputClass} />
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('detail.close')}
          </Button>
          <Button
            disabled={busy || !name.trim() || !at}
            onClick={() =>
              onSave({
                name: name.trim(),
                ...(moved ? { event_at: at?.toISOString() } : {}),
                location,
                join_link: joinLink,
                ...(quietChanged ? { quiet: { enabled: quietEnabled, from: quietFrom, to: quietTo } } : {}),
              })
            }
          >
            {t('detail.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AddReminderDialog({
  open,
  onOpenChange,
  campaign,
  data,
  busy,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  campaign: EventCampaignRow;
  data: ReturnType<typeof useEventFormData>;
  busy: boolean;
  onAdd: (d: ReminderDraft) => void;
}) {
  const t = useTranslations('EventCampaign');
  const [draft, setDraft] = useState<ReminderDraft>(() => newDraft('before'));

  const ev = eventContextOf(campaign);
  const problem = draftProblem(draft, ev);
  const plan = planReminder(ev.eventAt, draftOffset(draft), {
    enabled: campaign.quiet_enabled,
    from: campaign.quiet_from,
    to: campaign.quiet_to,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('detail.addReminder')}</DialogTitle>
        </DialogHeader>
        <ReminderEditor
          draft={draft}
          onChange={setDraft}
          data={data}
          ev={ev}
          footer={
            <p className="text-sm text-muted-foreground">
              {plan.sendAt ? t('reminders.willBeSent', { when: formatEventDateTime(plan.sendAt) }) : <span className="text-red-400">{t('detail.cannotSend')}</span>}
            </p>
          }
        />
        {problem && <p className="text-sm text-amber-400">{t(`reminders.errors.${problem}`)}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('detail.close')}
          </Button>
          <Button disabled={busy || problem !== null || plan.sendAt === null} onClick={() => onAdd(draft)}>
            {t('detail.addReminder')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}