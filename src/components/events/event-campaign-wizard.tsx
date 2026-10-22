'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Bell, CalendarDays, ChevronDown, ChevronUp, Loader2, Moon, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  formatEventDate,
  formatEventDateTime,
  formatEventTime,
  istToDate,
  offsetLabel,
  planReminder,
  validateOffset,
  type OffsetDirection,
  type QuietHours,
} from '@/lib/events/schedule';
import type { EventContext } from '@/lib/events/variables';
import {
  ReminderEditor,
  draftOffset,
  draftProblem,
  draftToInput,
  newDraft,
  useEventFormData,
  type EventFormData,
  type ReminderDraft,
} from './reminder-editor';

const STEPS = ['event', 'audience', 'reminders', 'review'] as const;

const inputClass =
  'h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

// Same dotted canvas the Automations builder uses.
const DOTS = 'bg-[radial-gradient(circle,var(--border)_1px,transparent_1px)] [background-size:20px_20px]';

export function EventCampaignWizard() {
  const t = useTranslations('EventCampaign');
  const router = useRouter();
  const data = useEventFormData();

  const [step, setStep] = useState(0);
  const [creating, setCreating] = useState(false);

  // Event
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('19:00');
  const [location, setLocation] = useState('');
  const [joinLink, setJoinLink] = useState('');
  // Audience
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [excludeTagIds, setExcludeTagIds] = useState<string[]>([]);
  // Reminders
  const [drafts, setDrafts] = useState<ReminderDraft[]>([]);
  const [quiet, setQuiet] = useState<QuietHours>({ enabled: true, from: '22:00', to: '08:00' });

  const eventAt = useMemo(() => (date ? istToDate(date, time) : null), [date, time]);
  const ev: EventContext = useMemo(
    () => ({ name: name.trim(), eventAt: eventAt ?? new Date(0), joinLink: joinLink.trim(), location: location.trim() }),
    [name, eventAt, joinLink, location],
  );

  // ── per-step validation ──────────────────────────────────────
  const eventError = useMemo<string | null>(() => {
    if (!name.trim()) return t('event.errors.nameRequired');
    if (!eventAt) return t('event.errors.dateInvalid');
    if (eventAt.getTime() <= Date.now()) return t('event.errors.past');
    if (joinLink.trim() && !/^https?:\/\/\S+$/i.test(joinLink.trim())) return t('event.errors.link');
    return null;
  }, [name, eventAt, joinLink, t]);

  const plans = useMemo(
    () => drafts.map((d) => planReminder(eventAt ?? new Date(0), draftOffset(d), quiet)),
    [drafts, eventAt, quiet],
  );

  const remindersError = useMemo<string | null>(() => {
    if (drafts.length === 0) return t('reminders.errors.needOne');
    const offsets = new Set<number>();
    for (const d of drafts) {
      const off = draftOffset(d);
      if (validateOffset(off)) return t('reminders.errors.offset');
      if (offsets.has(off)) return t('reminders.errors.duplicate');
      offsets.add(off);
      const problem = draftProblem(d, ev);
      if (problem) return t(`reminders.errors.${problem}`);
    }
    if (plans.every((p) => p.sendAt === null)) return t('reminders.errors.noneSendable');
    return null;
  }, [drafts, ev, plans, t]);

  const stepError = step === 0 ? eventError : step === 1 ? (tagIds.length === 0 ? t('audience.pickOne') : null) : step === 2 ? remindersError : null;

  async function create() {
    if (!eventAt) return;
    setCreating(true);
    try {
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          event_at: eventAt.toISOString(),
          location: location.trim() || null,
          join_link: joinLink.trim() || null,
          audience_tag_ids: tagIds,
          exclude_tag_ids: excludeTagIds,
          quiet,
          reminders: drafts.map(draftToInput),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || t('errorGeneric'));
      toast.success(t('review.created'));
      router.push(`/broadcasts/events/${body.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('errorGeneric'));
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <div className="grid grid-cols-4 gap-2">
        {STEPS.map((s, i) => (
          <div key={s} className="space-y-1">
            <div className={`h-1 rounded-full ${i <= step ? (i < step ? 'bg-emerald-500' : 'bg-primary') : 'bg-muted'}`} />
            <p className={`text-xs ${i === step ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
              {i + 1}. {t(`steps.${s}`)}
            </p>
          </div>
        ))}
      </div>

      {step === 0 && (
        <EventStep
          name={name}
          setName={setName}
          date={date}
          setDate={setDate}
          time={time}
          setTime={setTime}
          location={location}
          setLocation={setLocation}
          joinLink={joinLink}
          setJoinLink={setJoinLink}
          eventAt={eventAt}
        />
      )}
      {step === 1 && (
        <AudienceStep
          data={data}
          tagIds={tagIds}
          setTagIds={setTagIds}
          excludeTagIds={excludeTagIds}
          setExcludeTagIds={setExcludeTagIds}
        />
      )}
      {step === 2 && eventAt && (
        <RemindersStep
          data={data}
          ev={ev}
          eventAt={eventAt}
          name={name}
          drafts={drafts}
          setDrafts={setDrafts}
          quiet={quiet}
          setQuiet={setQuiet}
        />
      )}
      {step === 3 && eventAt && (
        <ReviewStep
          data={data}
          name={name.trim()}
          eventAt={eventAt}
          location={location.trim()}
          joinLink={joinLink.trim()}
          tagIds={tagIds}
          excludeTagIds={excludeTagIds}
          drafts={drafts}
          quiet={quiet}
        />
      )}

      {stepError && step > 0 && <p className="text-sm text-amber-400">{stepError}</p>}
      {stepError && step === 0 && (name || date) && <p className="text-sm text-amber-400">{stepError}</p>}

      <div className="flex items-center justify-between">
        <Button variant="outline" onClick={() => (step === 0 ? router.push('/broadcasts') : setStep(step - 1))} disabled={creating}>
          {t('back')}
        </Button>
        {step < STEPS.length - 1 ? (
          <Button onClick={() => setStep(step + 1)} disabled={stepError !== null}>
            {t('next')}
          </Button>
        ) : (
          <Button onClick={create} disabled={creating}>
            {creating ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> {t('review.creating')}
              </>
            ) : (
              t('review.create')
            )}
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Step 1: event ──────────────────────────────────────────────

function EventStep(p: {
  name: string;
  setName: (v: string) => void;
  date: string;
  setDate: (v: string) => void;
  time: string;
  setTime: (v: string) => void;
  location: string;
  setLocation: (v: string) => void;
  joinLink: string;
  setJoinLink: (v: string) => void;
  eventAt: Date | null;
}) {
  const t = useTranslations('EventCampaign.event');
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-foreground">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      <div className="space-y-4 rounded-xl border border-border bg-card p-5">
        <label className="block space-y-1 text-sm text-muted-foreground">
          {t('name')}
          <input value={p.name} maxLength={120} placeholder={t('namePlaceholder')} onChange={(e) => p.setName(e.target.value)} className={inputClass} />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1 text-sm text-muted-foreground">
            {t('date')}
            <input type="date" value={p.date} onChange={(e) => p.setDate(e.target.value)} className={inputClass} />
            {p.eventAt && <span className="block text-sm text-foreground">{formatEventDate(p.eventAt)}</span>}
          </label>
          <label className="block space-y-1 text-sm text-muted-foreground">
            {t('time')}
            <input type="time" value={p.time} onChange={(e) => p.setTime(e.target.value)} className={inputClass} />
            {p.eventAt && <span className="block text-sm text-foreground">{formatEventTime(p.eventAt)}</span>}
          </label>
        </div>
        <p className="text-xs text-muted-foreground">{t('istNote')}</p>

        <details className="rounded-lg border border-dashed border-border p-4">
          <summary className="cursor-pointer text-sm font-medium text-primary">{t('optional')}</summary>
          <div className="mt-3 space-y-3">
            <label className="block space-y-1 text-sm text-muted-foreground">
              {t('location')}
              <input value={p.location} placeholder={t('locationPlaceholder')} onChange={(e) => p.setLocation(e.target.value)} className={inputClass} />
            </label>
            <label className="block space-y-1 text-sm text-muted-foreground">
              {t('joinLink')}
              <input value={p.joinLink} placeholder="https://" onChange={(e) => p.setJoinLink(e.target.value)} className={inputClass} />
            </label>
            <p className="text-xs text-muted-foreground">{t('joinHint')}</p>
          </div>
        </details>
      </div>
    </section>
  );
}

// ── Step 2: audience ───────────────────────────────────────────

function AudienceStep({
  data,
  tagIds,
  setTagIds,
  excludeTagIds,
  setExcludeTagIds,
}: {
  data: EventFormData;
  tagIds: string[];
  setTagIds: (v: string[]) => void;
  excludeTagIds: string[];
  setExcludeTagIds: (v: string[]) => void;
}) {
  const t = useTranslations('EventCampaign.audience');
  const [count, setCount] = useState<number | null>(null);

  // Approximate "who matches right now" so the user can sanity-check the tags.
  useEffect(() => {
    let cancelled = false;
    if (tagIds.length === 0) return;
    (async () => {
      const supabase = createClient();
      const load = async (ids: string[]) => {
        const out = new Set<string>();
        if (ids.length === 0) return out;
        for (let from = 0; from < 20_000; from += 1000) {
          const { data: rows } = await supabase
            .from('contact_tags')
            .select('contact_id')
            .in('tag_id', ids)
            .order('contact_id', { ascending: true })
            .range(from, from + 999);
          for (const r of rows ?? []) out.add(r.contact_id as string);
          if (!rows || rows.length < 1000) break;
        }
        return out;
      };
      const [inc, exc] = await Promise.all([load(tagIds), load(excludeTagIds)]);
      if (cancelled) return;
      setCount([...inc].filter((id) => !exc.has(id)).length);
    })();
    return () => {
      cancelled = true;
    };
  }, [tagIds, excludeTagIds]);

  const toggle = (list: string[], set: (v: string[]) => void, other: string[], setOther: (v: string[]) => void, id: string) => {
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
    if (!list.includes(id) && other.includes(id)) setOther(other.filter((x) => x !== id));
  };

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-foreground">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      {data.loading ? (
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      ) : data.tags.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">{t('noTags')}</p>
      ) : (
        <div className="space-y-5 rounded-xl border border-border bg-card p-5">
          <TagPicker label={t('include')} tags={data.tags} selected={tagIds} onToggle={(id) => toggle(tagIds, setTagIds, excludeTagIds, setExcludeTagIds, id)} />
          <TagPicker label={t('exclude')} tags={data.tags} selected={excludeTagIds} onToggle={(id) => toggle(excludeTagIds, setExcludeTagIds, tagIds, setTagIds, id)} />
          {tagIds.length > 0 && count !== null && <p className="text-sm font-medium text-foreground">{t('matching', { count })}</p>}
        </div>
      )}
    </section>
  );
}

function TagPicker({
  label,
  tags,
  selected,
  onToggle,
}: {
  label: string;
  tags: EventFormData['tags'];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-2">
        {tags.map((tag) => {
          const on = selected.includes(tag.id);
          return (
            <button
              key={tag.id}
              type="button"
              onClick={() => onToggle(tag.id)}
              className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                on ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:border-primary/50'
              }`}
            >
              {tag.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Step 3: reminders (flow) ───────────────────────────────────

function RemindersStep({
  data,
  ev,
  eventAt,
  name,
  drafts,
  setDrafts,
  quiet,
  setQuiet,
}: {
  data: EventFormData;
  ev: EventContext;
  eventAt: Date;
  name: string;
  drafts: ReminderDraft[];
  setDrafts: (v: ReminderDraft[]) => void;
  quiet: QuietHours;
  setQuiet: (q: QuietHours) => void;
}) {
  const t = useTranslations('EventCampaign.reminders');
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set());
  const [quietOpen, setQuietOpen] = useState(false);

  const items = drafts
    .map((d) => ({ d, off: draftOffset(d) }))
    .sort((a, b) => a.off - b.off);
  const before = items.filter((x) => x.off < 0);
  const after = items.filter((x) => x.off >= 0);

  const add = (direction: OffsetDirection) => {
    const d = newDraft(direction);
    setDrafts([...drafts, d]);
    setOpenKeys(new Set(openKeys).add(d.key));
  };
  const update = (d: ReminderDraft) => setDrafts(drafts.map((x) => (x.key === d.key ? d : x)));
  const remove = (key: string) => setDrafts(drafts.filter((x) => x.key !== key));
  const toggleOpen = (key: string) => {
    const next = new Set(openKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setOpenKeys(next);
  };

  const node = (x: { d: ReminderDraft; off: number }) => {
    return (
      <ReminderNode
        key={x.d.key}
        index={items.findIndex((i) => i.d.key === x.d.key) + 1}
        draft={x.d}
        data={data}
        ev={ev}
        eventAt={eventAt}
        quiet={quiet}
        open={openKeys.has(x.d.key)}
        onToggle={() => toggleOpen(x.d.key)}
        onChange={update}
        onRemove={() => remove(x.d.key)}
      />
    );
  };

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-foreground">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <div className={`rounded-xl border border-border p-4 sm:p-6 ${DOTS}`}>
        <div className="mx-auto max-w-2xl">
          <Connector title={t('addHere')} onClick={() => add('before')} />
          {before.map((x) => (
            <div key={x.d.key}>
              {node(x)}
              <Connector title={t('addHere')} onClick={() => add('before')} />
            </div>
          ))}

          <div className="flex items-center gap-3 rounded-xl border border-border border-l-4 border-l-blue-500 bg-card p-4">
            <CalendarDays className="h-5 w-5 shrink-0 text-blue-400" />
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-blue-400">{t('eventLabel')}</p>
              <p className="truncate font-semibold text-foreground">{name.trim()}</p>
              <p className="text-xs text-muted-foreground">{formatEventDateTime(eventAt)} IST</p>
            </div>
          </div>

          {after.map((x) => (
            <div key={x.d.key}>
              <Connector title={t('addHere')} onClick={() => add('after')} />
              {node(x)}
            </div>
          ))}
          <Connector title={t('addHere')} onClick={() => add('after')} />

          <div className="rounded-xl border border-border border-l-4 border-l-amber-500 bg-card">
            <button type="button" onClick={() => setQuietOpen(!quietOpen)} className="flex w-full items-center gap-3 p-4 text-left">
              <Moon className="h-5 w-5 shrink-0 text-amber-400" />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-400">{t('setting')}</p>
                <p className="font-semibold text-foreground">{t('quietTitle')}</p>
                <p className="text-xs text-muted-foreground">
                  {quiet.enabled ? t('quietOn', { from: quiet.from, to: quiet.to }) : t('quietOff')}
                </p>
              </div>
              {quietOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
            </button>
            {quietOpen && (
              <div className="space-y-3 border-t border-border p-4">
                <label className="flex items-center gap-3 text-sm text-foreground">
                  <Switch checked={quiet.enabled} onCheckedChange={(v: boolean) => setQuiet({ ...quiet, enabled: v })} />
                  {quiet.enabled ? t('on') : t('off')}
                </label>
                <p className="text-xs text-muted-foreground">{t('quietDesc')}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1 text-xs text-muted-foreground">
                    {t('quietFrom')}
                    <input type="time" value={quiet.from} disabled={!quiet.enabled} onChange={(e) => e.target.value && setQuiet({ ...quiet, from: e.target.value })} className={inputClass} />
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    {t('quietUntil')}
                    <input type="time" value={quiet.to} disabled={!quiet.enabled} onChange={(e) => e.target.value && setQuiet({ ...quiet, to: e.target.value })} className={inputClass} />
                  </label>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function Connector({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <div className="flex flex-col items-center">
      <div className="h-5 w-px bg-border" />
      <button
        type="button"
        title={title}
        onClick={onClick}
        className="flex h-7 w-7 items-center justify-center rounded-full border border-dashed border-muted-foreground/60 text-muted-foreground transition-colors hover:border-primary hover:text-primary"
      >
        <Plus className="h-4 w-4" />
      </button>
      <div className="h-5 w-px bg-border" />
    </div>
  );
}

function ReminderNode({
  index,
  draft,
  data,
  ev,
  eventAt,
  quiet,
  open,
  onToggle,
  onChange,
  onRemove,
}: {
  index: number;
  draft: ReminderDraft;
  data: EventFormData;
  ev: EventContext;
  eventAt: Date;
  quiet: QuietHours;
  open: boolean;
  onToggle: () => void;
  onChange: (d: ReminderDraft) => void;
  onRemove: () => void;
}) {
  const t = useTranslations('EventCampaign.reminders');
  const offset = draftOffset(draft);
  const plan = planReminder(eventAt, offset, quiet);
  const skipText =
    plan.skipReason === 'quiet_hours_after_event' ? t('skippedQuiet') : plan.skipReason === 'already_past' ? t('skippedPast') : null;

  return (
    <div className="rounded-xl border border-border border-l-4 border-l-violet-500 bg-card">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 p-4 text-left">
        <Bell className="h-5 w-5 shrink-0 text-violet-400" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-violet-400">{t('reminderLabel', { n: index })}</p>
          <p className="font-semibold text-foreground">{offsetLabel(offset)}</p>
          <p className="truncate text-xs text-muted-foreground">
            {draft.template?.name ?? t('noTemplate')}
            {plan.sendAt ? ` · ${formatEventDateTime(plan.sendAt)}` : ''}
          </p>
        </div>
        {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
      </button>
      {open && (
        <div className="border-t border-border p-4">
          <ReminderEditor
            draft={draft}
            onChange={onChange}
            data={data}
            ev={ev}
            footer={
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-muted-foreground">
                  {skipText ? (
                    <span className="text-red-400">{skipText}</span>
                  ) : plan.sendAt ? (
                    <>
                      {t('willBeSent', { when: formatEventDateTime(plan.sendAt) })}
                      {plan.movedByQuietHours && (
                        <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-400">{t('movedQuiet')}</span>
                      )}
                    </>
                  ) : null}
                </span>
                <button type="button" onClick={onRemove} className="text-red-400 hover:underline">
                  {t('remove')}
                </button>
              </div>
            }
          />
        </div>
      )}
    </div>
  );
}

// ── Step 4: review ─────────────────────────────────────────────

function ReviewStep({
  data,
  name,
  eventAt,
  location,
  joinLink,
  tagIds,
  excludeTagIds,
  drafts,
  quiet,
}: {
  data: EventFormData;
  name: string;
  eventAt: Date;
  location: string;
  joinLink: string;
  tagIds: string[];
  excludeTagIds: string[];
  drafts: ReminderDraft[];
  quiet: QuietHours;
}) {
  const t = useTranslations('EventCampaign.review');
  const names = (ids: string[]) => ids.map((id) => data.tags.find((x) => x.id === id)?.name ?? '').filter(Boolean).join(', ');
  const rows = drafts
    .map((d) => ({ d, off: draftOffset(d) }))
    .sort((a, b) => a.off - b.off)
    .map((x) => ({ ...x, plan: planReminder(eventAt, x.off, quiet) }));

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-foreground">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      <div className="space-y-4 rounded-xl border border-border bg-card p-5 text-sm">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{t('event')}</p>
          <p className="font-semibold text-foreground">{name}</p>
          <p className="text-muted-foreground">{formatEventDateTime(eventAt)} IST</p>
          {location && <p className="text-muted-foreground">{location}</p>}
          {joinLink && <p className="truncate text-muted-foreground">{joinLink}</p>}
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{t('audience')}</p>
          <p className="text-foreground">{t('tagsAny', { tags: names(tagIds) })}</p>
          {excludeTagIds.length > 0 && <p className="text-muted-foreground">{t('tagsExclude', { tags: names(excludeTagIds) })}</p>}
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{t('reminders')}</p>
          <ul className="mt-1 space-y-1">
            {rows.map(({ d, off, plan }) => (
              <li key={d.key} className="flex flex-wrap justify-between gap-2">
                <span className="text-foreground">
                  {offsetLabel(off)} <span className="text-muted-foreground">· {d.template?.name}</span>
                </span>
                <span className={plan.sendAt ? 'text-muted-foreground' : 'text-red-400'}>
                  {plan.sendAt ? formatEventDateTime(plan.sendAt) : t('willSkip')}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{t('quiet')}</p>
          <p className="text-foreground">{quiet.enabled ? `${quiet.from} – ${quiet.to} IST` : t('quietOff')}</p>
        </div>
      </div>
    </section>
  );
}