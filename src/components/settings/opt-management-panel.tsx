'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Plus, ShieldCheck, UserCheck, UserX, Users, X } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import type { MessageTemplate, OptKeyword, OptResponse, OptDirection } from '@/types';

interface OptManagementState {
  keywords: OptKeyword[];
  responses: OptResponse[];
}

const MAX_ENABLED_OPT_OUT_KEYWORDS = 5;

export function OptManagementPanel() {
  const t = useTranslations('Settings.optManagement');
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<OptManagementState>({ keywords: [], responses: [] });
  const [templates, setTemplates] = useState<Pick<MessageTemplate, 'id' | 'name'>[]>([]);
  const [counts, setCounts] = useState<{ opted_in: number; opted_out: number; unknown: number } | null>(
    null,
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/settings/opt-management', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setState({ keywords: data.keywords ?? [], responses: data.responses ?? [] });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCounts = useCallback(async () => {
    const [inRes, outRes, unknownRes] = await Promise.all([
      supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('subscription_status', 'opted_in'),
      supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('subscription_status', 'opted_out'),
      supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('subscription_status', 'unknown'),
    ]);
    setCounts({
      opted_in: inRes.count ?? 0,
      opted_out: outRes.count ?? 0,
      unknown: unknownRes.count ?? 0,
    });
  }, [supabase]);

  const loadTemplates = useCallback(async () => {
    const { data } = await supabase.from('message_templates').select('id, name').order('name');
    setTemplates(data ?? []);
  }, [supabase]);

  useEffect(() => {
    void load();
    void loadCounts();
    void loadTemplates();
  }, [load, loadCounts, loadTemplates]);

  const keywordsFor = useCallback(
    (direction: OptDirection) => state.keywords.filter((k) => k.direction === direction),
    [state.keywords],
  );
  const responseFor = useCallback(
    (direction: OptDirection) => state.responses.find((r) => r.direction === direction) ?? null,
    [state.responses],
  );

  const enabledOptOutCount = useMemo(
    () => keywordsFor('out').filter((k) => k.enabled).length,
    [keywordsFor],
  );

  async function addKeyword(direction: OptDirection, keyword: string, matchType: 'exact' | 'contains') {
    if (!keyword.trim()) return;
    if (direction === 'out' && enabledOptOutCount >= MAX_ENABLED_OPT_OUT_KEYWORDS) {
      toast.error(t('keywords.maxOptOutReached', { count: MAX_ENABLED_OPT_OUT_KEYWORDS }));
      return;
    }
    const res = await fetch('/api/settings/opt-management/keywords', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ direction, keyword, match_type: matchType, enabled: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(data.error ?? t('keywords.addFailed'));
      return;
    }
    setState((s) => ({ ...s, keywords: [...s.keywords, data.keyword] }));
  }

  async function toggleKeyword(id: string, enabled: boolean) {
    const res = await fetch(`/api/settings/opt-management/keywords/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(data.error ?? t('keywords.updateFailed'));
      return;
    }
    setState((s) => ({
      ...s,
      keywords: s.keywords.map((k) => (k.id === id ? { ...k, enabled } : k)),
    }));
  }

  async function removeKeyword(id: string) {
    const res = await fetch(`/api/settings/opt-management/keywords/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error(t('keywords.deleteFailed'));
      return;
    }
    setState((s) => ({ ...s, keywords: s.keywords.filter((k) => k.id !== id) }));
  }

  async function saveResponse(direction: OptDirection, patch: Partial<OptResponse>) {
    const current = responseFor(direction);
    const body = {
      direction,
      enabled: patch.enabled ?? current?.enabled ?? true,
      response_type: patch.response_type ?? current?.response_type ?? 'message',
      template_id: patch.template_id !== undefined ? patch.template_id : current?.template_id ?? null,
      message_text: patch.message_text !== undefined ? patch.message_text : current?.message_text ?? '',
    };
    const res = await fetch('/api/settings/opt-management/responses', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(data.error ?? t('responses.saveFailed'));
      return;
    }
    setState((s) => ({
      ...s,
      responses: [...s.responses.filter((r) => r.direction !== direction), data.response],
    }));
    toast.success(t('responses.saved'));
  }

  if (loading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      </section>
    );
  }

  return (
    <section className="animate-in fade-in-50 duration-200 space-y-6">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {/* Summary */}
      <Card>
        <CardHeader>
          <CardTitle className="text-foreground text-base">{t('summary.title')}</CardTitle>
          <CardDescription className="text-muted-foreground">{t('summary.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatTile icon={UserCheck} label={t('summary.optedIn')} value={counts?.opted_in ?? 0} tone="green" />
            <StatTile icon={UserX} label={t('summary.optedOut')} value={counts?.opted_out ?? 0} tone="red" />
            <StatTile icon={Users} label={t('summary.unknown')} value={counts?.unknown ?? 0} tone="muted" />
          </div>
        </CardContent>
      </Card>

      <KeywordCard
        direction="in"
        title={t('optInKeywords.title')}
        description={t('optInKeywords.description')}
        keywords={keywordsFor('in')}
        onAdd={(kw, mt) => addKeyword('in', kw, mt)}
        onToggle={toggleKeyword}
        onRemove={removeKeyword}
        t={t}
      />

      <ResponseCard
        direction="in"
        title={t('optInResponse.title')}
        description={t('optInResponse.description')}
        response={responseFor('in')}
        templates={templates}
        onSave={(patch) => saveResponse('in', patch)}
        t={t}
      />

      <KeywordCard
        direction="out"
        title={t('optOutKeywords.title')}
        description={t('optOutKeywords.description')}
        keywords={keywordsFor('out')}
        onAdd={(kw, mt) => addKeyword('out', kw, mt)}
        onToggle={toggleKeyword}
        onRemove={removeKeyword}
        maxEnabledNote={t('keywords.maxOptOutNote', { count: MAX_ENABLED_OPT_OUT_KEYWORDS })}
        t={t}
      />

      <ResponseCard
        direction="out"
        title={t('optOutResponse.title')}
        description={t('optOutResponse.description')}
        response={responseFor('out')}
        templates={templates}
        onSave={(patch) => saveResponse('out', patch)}
        t={t}
      />

      {/* API & Advanced */}
      <Card>
        <CardHeader>
          <CardTitle className="text-foreground text-base flex items-center gap-2">
            <ShieldCheck className="size-4 text-primary" />
            {t('advanced.title')}
          </CardTitle>
          <CardDescription className="text-muted-foreground">{t('advanced.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{t('advanced.apiOptOutLabel')}</p>
              <p className="text-xs text-muted-foreground">{t('advanced.apiOptOutHint')}</p>
            </div>
            <Switch checked disabled aria-label={t('advanced.apiOptOutLabel')} />
          </div>
          <p className="text-xs text-muted-foreground">{t('advanced.enforcementNote')}</p>
        </CardContent>
      </Card>
    </section>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof UserCheck;
  label: string;
  value: number;
  tone: 'green' | 'red' | 'muted';
}) {
  const toneClass =
    tone === 'green'
      ? 'text-green-600 dark:text-green-400 bg-green-500/10'
      : tone === 'red'
        ? 'text-red-500 bg-red-500/10'
        : 'text-muted-foreground bg-muted';
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border p-3">
      <div className={`flex size-9 shrink-0 items-center justify-center rounded-full ${toneClass}`}>
        <Icon className="size-4" />
      </div>
      <div className="min-w-0">
        <p className="text-lg font-semibold text-foreground">{value.toLocaleString()}</p>
        <p className="text-xs text-muted-foreground truncate">{label}</p>
      </div>
    </div>
  );
}

function KeywordCard({
  direction,
  title,
  description,
  keywords,
  onAdd,
  onToggle,
  onRemove,
  maxEnabledNote,
  t,
}: {
  direction: OptDirection;
  title: string;
  description: string;
  keywords: OptKeyword[];
  onAdd: (keyword: string, matchType: 'exact' | 'contains') => void;
  onToggle: (id: string, enabled: boolean) => void;
  onRemove: (id: string) => void;
  maxEnabledNote?: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const [draft, setDraft] = useState('');
  const [matchType, setMatchType] = useState<'exact' | 'contains'>('contains');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground text-base">{title}</CardTitle>
        <CardDescription className="text-muted-foreground">{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('keywords.placeholder')}
            className="bg-muted text-foreground"
          />
          <select
            value={matchType}
            onChange={(e) => setMatchType(e.target.value as 'exact' | 'contains')}
            className="h-9 shrink-0 rounded-md border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          >
            <option value="contains">{t('keywords.matchContains')}</option>
            <option value="exact">{t('keywords.matchExact')}</option>
          </select>
          <Button
            onClick={() => {
              onAdd(draft, matchType);
              setDraft('');
            }}
            disabled={!draft.trim()}
            className="shrink-0"
          >
            <Plus className="size-4" />
            {t('keywords.add')}
          </Button>
        </div>

        {keywords.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('keywords.empty')}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {keywords.map((k) => (
              <span
                key={k.id}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
                  k.enabled
                    ? 'border-primary/30 bg-primary/10 text-primary'
                    : 'border-border bg-muted text-muted-foreground'
                }`}
              >
                {k.keyword}
                <span className="text-[10px] opacity-70">
                  ({k.match_type === 'exact' ? t('keywords.matchExact') : t('keywords.matchContains')})
                </span>
                <button
                  type="button"
                  onClick={() => onToggle(k.id, !k.enabled)}
                  className="hover:opacity-70"
                  aria-label={k.enabled ? t('keywords.disable') : t('keywords.enable')}
                >
                  <Switch checked={k.enabled} onCheckedChange={(v) => onToggle(k.id, !!v)} className="scale-75" />
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(k.id)}
                  aria-label={t('keywords.remove')}
                  className="hover:opacity-70"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        {direction === 'out' && maxEnabledNote && (
          <p className="text-xs text-muted-foreground">{maxEnabledNote}</p>
        )}
      </CardContent>
    </Card>
  );
}

function ResponseCard({
  direction,
  title,
  description,
  response,
  templates,
  onSave,
  t,
}: {
  direction: OptDirection;
  title: string;
  description: string;
  response: OptResponse | null;
  templates: Pick<MessageTemplate, 'id' | 'name'>[];
  onSave: (patch: Partial<OptResponse>) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const [enabled, setEnabled] = useState(response?.enabled ?? false);
  const [responseType, setResponseType] = useState<'template' | 'message'>(
    response?.response_type ?? 'message',
  );
  const [templateId, setTemplateId] = useState(response?.template_id ?? '');
  const [messageText, setMessageText] = useState(response?.message_text ?? '');

  // Re-sync the local draft when a new `response` object arrives from the
  // server (e.g. after the initial fetch resolves, or after a save
  // round-trip). Adjusted directly during render — per React's guidance
  // on resetting state from props — instead of in a useEffect, so this
  // doesn't trigger an extra "setState inside an effect" render pass.
  const [syncedResponse, setSyncedResponse] = useState(response);
  if (response !== syncedResponse) {
    setSyncedResponse(response);
    setEnabled(response?.enabled ?? false);
    setResponseType(response?.response_type ?? 'message');
    setTemplateId(response?.template_id ?? '');
    setMessageText(response?.message_text ?? '');
  }

  return (
    <Card data-direction={direction}>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-foreground text-base">{title}</CardTitle>
          <CardDescription className="text-muted-foreground">{description}</CardDescription>
        </div>
        <Switch checked={enabled} onCheckedChange={(v) => setEnabled(!!v)} />
      </CardHeader>
      {enabled && (
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <TypeTab
              active={responseType === 'message'}
              label={t('responses.messageType')}
              onClick={() => setResponseType('message')}
            />
            <TypeTab
              active={responseType === 'template'}
              label={t('responses.templateType')}
              onClick={() => setResponseType('template')}
            />
          </div>
          {responseType === 'message' ? (
            <Textarea
              value={messageText ?? ''}
              onChange={(e) => setMessageText(e.target.value)}
              placeholder={t('responses.messagePlaceholder')}
              className="min-h-24 bg-muted text-foreground"
            />
          ) : (
            <select
              value={templateId ?? ''}
              onChange={(e) => setTemplateId(e.target.value)}
              className="h-9 w-full rounded-md border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            >
              <option value="">{t('responses.selectTemplate')}</option>
              {templates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.name}
                </option>
              ))}
            </select>
          )}
          <div className="flex justify-end">
            <Button
              onClick={() =>
                onSave({
                  enabled,
                  response_type: responseType,
                  template_id: responseType === 'template' ? templateId || null : null,
                  message_text: responseType === 'message' ? messageText : null,
                })
              }
            >
              {t('responses.save')}
            </Button>
          </div>
        </CardContent>
      )}
      {!enabled && (
        <CardContent>
          <div className="flex justify-end">
            <Button variant="outline" onClick={() => onSave({ enabled: false })}>
              {t('responses.save')}
            </Button>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function TypeTab({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? 'flex-1 rounded-md border border-primary bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary'
          : 'flex-1 rounded-md border border-border bg-muted px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground'
      }
    >
      {label}
    </button>
  );
}