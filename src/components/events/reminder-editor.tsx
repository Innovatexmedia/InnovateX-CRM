'use client';

import { useEffect, useState } from 'react';
import { Eye, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toOffsetMinutes, type OffsetDirection, type OffsetUnit } from '@/lib/events/schedule';
import {
  CONTACT_FIELDS,
  EVENT_FIELDS,
  resolveEventVariables,
  type EventContext,
  type EventVariableMapping,
  type EventVariableType,
} from '@/lib/events/variables';
import type { ReminderInput } from '@/lib/events/types';
import type { CustomField, MessageTemplate, Tag } from '@/types';

// ── shared data ────────────────────────────────────────────────

export interface EventFormData {
  templates: MessageTemplate[];
  customFields: CustomField[];
  tags: Tag[];
  loading: boolean;
  error: string | null;
}

/** Approved templates, custom fields and tags — loaded once per page. */
export function useEventFormData(): EventFormData {
  const [data, setData] = useState<EventFormData>({
    templates: [],
    customFields: [],
    tags: [],
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const supabase = createClient();
        const [tpl, fields, tags] = await Promise.all([
          // Only APPROVED templates can be sent via Meta.
          supabase
            .from('message_templates')
            .select('*')
            .eq('status', 'APPROVED')
            .order('created_at', { ascending: false }),
          supabase.from('custom_fields').select('*').order('field_name'),
          supabase.from('tags').select('*').order('name'),
        ]);
        if (cancelled) return;
        const failure = tpl.error ?? fields.error ?? tags.error;
        setData({
          templates: (tpl.data ?? []) as MessageTemplate[],
          customFields: (fields.data ?? []) as CustomField[],
          tags: (tags.data ?? []) as Tag[],
          loading: false,
          error: failure ? failure.message : null,
        });
      } catch (err) {
        if (!cancelled) {
          setData((d) => ({
            ...d,
            loading: false,
            error: err instanceof Error ? err.message : 'Failed to load',
          }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return data;
}

// ── draft model ────────────────────────────────────────────────

export interface ReminderDraft {
  key: string;
  amount: number;
  unit: OffsetUnit;
  direction: OffsetDirection;
  template: MessageTemplate | null;
  variables: Record<string, EventVariableMapping>;
  headerMediaUrl: string;
}

let draftCounter = 0;

export function newDraft(direction: OffsetDirection): ReminderDraft {
  draftCounter += 1;
  return {
    key: `d${draftCounter}-${Date.now()}`,
    amount: direction === 'start' ? 0 : 1,
    unit: 'hours',
    direction,
    template: null,
    variables: {},
    headerMediaUrl: '',
  };
}

export function draftOffset(d: ReminderDraft): number {
  return toOffsetMinutes(d.amount, d.unit, d.direction);
}

export function placeholdersOf(template: MessageTemplate | null): string[] {
  if (!template) return [];
  const keys = (template.body_text.match(/\{\{(\d+)\}\}/g) ?? []).map((p) => p.replace(/[{}]/g, ''));
  return [...new Set(keys)].sort((a, b) => Number(a) - Number(b));
}

/**
 * A sensible first guess for what {{n}} should be, from its position and
 * the words just before it. The user can change every one.
 */
function defaultMapping(template: MessageTemplate, key: string): EventVariableMapping {
  const body = template.body_text;
  const at = body.indexOf(`{{${key}}}`);
  const before = at > 0 ? body.slice(Math.max(0, at - 40), at) : '';
  if (/(link|join|watch|here)\W*$/i.test(before)) return { type: 'event', value: 'join_link' };
  if (key === '1') return { type: 'field', value: 'first_name', fallback: 'there' };
  if (key === '2') return { type: 'event', value: 'event_name' };
  if (key === '3') return { type: 'event', value: 'event_datetime' };
  if (key === '4') return { type: 'event', value: 'location' };
  return { type: 'static', value: '' };
}

/** Pick a template: reset the mapping to defaults for its placeholders. */
export function withTemplate(draft: ReminderDraft, template: MessageTemplate): ReminderDraft {
  const variables: Record<string, EventVariableMapping> = {};
  for (const k of placeholdersOf(template)) variables[k] = defaultMapping(template, k);
  const media =
    template.header_type === 'image' || template.header_type === 'video' || template.header_type === 'document';
  return {
    ...draft,
    template,
    variables,
    headerMediaUrl: media ? (template.header_media_url ?? '') : '',
  };
}

export function draftToInput(d: ReminderDraft): ReminderInput {
  return {
    offset_minutes: draftOffset(d),
    template_name: d.template?.name ?? '',
    template_language: d.template?.language,
    variables: d.variables,
    header_media_url: d.headerMediaUrl.trim() || null,
  };
}

/** Why this draft can't be saved yet, as a translation key, or null. */
export function draftProblem(d: ReminderDraft, ev: EventContext): 'needTemplate' | 'fillVars' | 'needMedia' | 'needLink' | null {
  if (!d.template) return 'needTemplate';
  for (const k of placeholdersOf(d.template)) {
    const m = d.variables[k];
    if (!m) return 'fillVars';
    if (m.type === 'static' && !m.value.trim()) return 'fillVars';
    if (m.type === 'custom_field' && !m.value) return 'fillVars';
    if (m.type === 'event' && m.value === 'join_link' && !(ev.joinLink ?? '').trim() && !(m.fallback ?? '').trim()) return 'needLink';
    if (m.type === 'event' && m.value === 'location' && !(ev.location ?? '').trim() && !(m.fallback ?? '').trim()) return 'needLink';
  }
  const media = d.template.header_type === 'image' || d.template.header_type === 'video' || d.template.header_type === 'document';
  if (media && !/^https?:\/\//i.test(d.headerMediaUrl.trim())) return 'needMedia';
  return null;
}

// ── editor ─────────────────────────────────────────────────────

const SAMPLE_CONTACT = { name: 'Rahul Sharma', phone: '+919876543210', email: 'rahul@example.com', company: 'Acme' };

const selectClass =
  'h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';
const inputClass = selectClass;

interface ReminderEditorProps {
  draft: ReminderDraft;
  onChange: (d: ReminderDraft) => void;
  data: EventFormData;
  ev: EventContext;
  /** Extra line under the form, e.g. "Will be sent: …". */
  footer?: React.ReactNode;
}

export function ReminderEditor({ draft, onChange, data, ev, footer }: ReminderEditorProps) {
  const t = useTranslations('EventCampaign.reminders');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [previewing, setPreviewing] = useState<MessageTemplate | null>(null);
  const keys = placeholdersOf(draft.template);
  const isStart = draft.direction === 'start';
  const mediaHeader =
    draft.template?.header_type === 'image' ||
    draft.template?.header_type === 'video' ||
    draft.template?.header_type === 'document';

  const setVar = (k: string, m: EventVariableMapping) =>
    onChange({ ...draft, variables: { ...draft.variables, [k]: m } });

  const previewText = draft.template
    ? renderBody(draft.template.body_text, resolveEventVariables(draft.variables, SAMPLE_CONTACT, undefined, ev))
    : '';

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="space-y-1 text-xs text-muted-foreground">
          {t('amount')}
          <input
            type="number"
            min={0}
            value={draft.amount}
            disabled={isStart}
            onChange={(e) => onChange({ ...draft, amount: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
            className={inputClass}
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          {t('unit')}
          <select
            value={draft.unit}
            disabled={isStart}
            onChange={(e) => onChange({ ...draft, unit: e.target.value as OffsetUnit })}
            className={selectClass}
          >
            <option value="minutes">{t('units.minutes')}</option>
            <option value="hours">{t('units.hours')}</option>
            <option value="days">{t('units.days')}</option>
          </select>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          {t('when')}
          <select
            value={draft.direction}
            onChange={(e) => onChange({ ...draft, direction: e.target.value as OffsetDirection })}
            className={selectClass}
          >
            <option value="before">{t('whenBefore')}</option>
            <option value="start">{t('whenStart')}</option>
            <option value="after">{t('whenAfter')}</option>
          </select>
        </label>
        <div className="space-y-1 text-xs text-muted-foreground">
          {t('template')}
          <div className="flex h-10 items-center gap-2 rounded-lg border border-border bg-background px-2">
            <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={draft.template?.name}>
              {draft.template?.name ?? t('noTemplate')}
            </span>
            {draft.template && (
              <>
                <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
                  {t('approved')}
                </span>
                <button
                  type="button"
                  title={t('previewTemplate')}
                  onClick={() => setPreviewing(draft.template)}
                  className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Eye className="h-4 w-4" />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-muted"
            >
              {draft.template ? t('change') : t('choose')}
            </button>
          </div>
        </div>
      </div>

      {draft.template && keys.length === 0 && (
        <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">{t('noVars')}</p>
      )}

      {draft.template &&
        keys.map((k) => {
          const m = draft.variables[k] ?? ({ type: 'static', value: '' } as EventVariableMapping);
          return (
            <div key={k} className="grid items-center gap-2 sm:grid-cols-[3rem_1fr_1fr_1fr]">
              <span className="rounded-md bg-primary/10 px-2 py-1 text-center text-xs font-semibold text-primary">
                {`{{${k}}}`}
              </span>
              <select
                value={m.type}
                onChange={(e) => setVar(k, emptyMapping(e.target.value as EventVariableType, data.customFields))}
                className={selectClass}
              >
                <option value="static">{t('varType.static')}</option>
                <option value="field">{t('varType.field')}</option>
                <option value="custom_field">{t('varType.custom')}</option>
                <option value="event">{t('varType.event')}</option>
              </select>

              {m.type === 'static' ? (
                <>
                  <input
                    value={m.value}
                    placeholder={t('typeValue')}
                    onChange={(e) => setVar(k, { ...m, value: e.target.value })}
                    className={inputClass}
                  />
                  <span className="text-xs text-muted-foreground">{t('sameForEveryone')}</span>
                </>
              ) : (
                <>
                  <select value={m.value} onChange={(e) => setVar(k, { ...m, value: e.target.value })} className={selectClass}>
                    {m.type === 'field' &&
                      CONTACT_FIELDS.map((f) => (
                        <option key={f} value={f}>
                          {t(`contactFields.${f}`)}
                        </option>
                      ))}
                    {m.type === 'custom_field' &&
                      data.customFields.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.field_name}
                        </option>
                      ))}
                    {m.type === 'event' &&
                      EVENT_FIELDS.map((f) => (
                        <option key={f} value={f}>
                          {t(`eventFields.${f}`)}
                        </option>
                      ))}
                  </select>
                  <input
                    value={m.fallback ?? ''}
                    placeholder={t('fallback')}
                    onChange={(e) => setVar(k, { ...m, fallback: e.target.value })}
                    className={inputClass}
                  />
                </>
              )}
            </div>
          );
        })}

      {mediaHeader && (
        <label className="block space-y-1 text-xs text-muted-foreground">
          {t('mediaUrl')}
          <input
            value={draft.headerMediaUrl}
            placeholder="https://"
            onChange={(e) => onChange({ ...draft, headerMediaUrl: e.target.value })}
            className={inputClass}
          />
        </label>
      )}

      {draft.template && keys.length > 0 && (
        <div className="whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 text-sm text-foreground">
          {previewText}
        </div>
      )}

      {footer}

      <TemplatePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        data={data}
        onPick={(tpl) => {
          onChange(withTemplate(draft, tpl));
          setPickerOpen(false);
        }}
      />

      <Dialog open={previewing !== null} onOpenChange={(o) => !o && setPreviewing(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="truncate">{previewing?.name}</DialogTitle>
          </DialogHeader>
          {previewing?.header_type === 'text' && previewing.header_content && (
            <p className="font-semibold text-foreground">{previewing.header_content}</p>
          )}
          <p className="whitespace-pre-wrap text-sm text-foreground">{previewing?.body_text}</p>
          {previewing?.footer_text && <p className="text-xs text-muted-foreground">{previewing.footer_text}</p>}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function emptyMapping(type: EventVariableType, customFields: CustomField[]): EventVariableMapping {
  switch (type) {
    case 'field':
      return { type, value: 'first_name', fallback: 'there' };
    case 'custom_field':
      return { type, value: customFields[0]?.id ?? '', fallback: '' };
    case 'event':
      return { type, value: 'event_name' };
    default:
      return { type: 'static', value: '' };
  }
}

function renderBody(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, raw: string) => params[Number(raw) - 1] || `{{${raw}}}`);
}

// ── template picker ────────────────────────────────────────────

function TemplatePicker({
  open,
  onOpenChange,
  data,
  onPick,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  data: EventFormData;
  onPick: (t: MessageTemplate) => void;
}) {
  const t = useTranslations('EventCampaign.reminders');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('pickTemplate')}</DialogTitle>
        </DialogHeader>
        {data.loading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          </div>
        ) : data.templates.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('noTemplates')}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {data.templates.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                onClick={() => onPick(tpl)}
                className="min-w-0 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/60"
              >
                <p className="truncate font-semibold text-foreground" title={tpl.name}>
                  {tpl.name}
                </p>
                <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">{tpl.body_text}</p>
                <span className="mt-2 inline-block rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
                  {t('approved')}
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="flex justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('close')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}