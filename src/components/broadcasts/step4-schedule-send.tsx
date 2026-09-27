'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ArrowLeft, Send, Loader2, Users, Save, CalendarClock } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface AudienceConfig {
  type: string;
  tagIds?: string[];
  csvContacts?: { phone: string; name?: string }[];
}

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  audience: AudienceConfig;
  onSend: () => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
  /** ISO datetime string (local, no timezone conversion needed — the
   *  <input type="datetime-local"> value is used as-is). `null` means
   *  "send now"; this is the source of truth for the toggle. */
  scheduledAt: string | null;
  onScheduledAtChange: (value: string | null) => void;
}

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  audience,
  onSend,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
  scheduledAt,
  onScheduledAtChange,
}: Step4Props) {
  const t = useTranslations('Broadcasts.wizard');
  const [showConfirm, setShowConfirm] = useState(false);
  const [estimatedReach, setEstimatedReach] = useState<number>(0);
  const [loadingReach, setLoadingReach] = useState(true);

  // scheduledAt is the single source of truth for the toggle below:
  // null = send now, a value = scheduled for then.
  const isScheduleMode = scheduledAt !== null;
  // The browser's own "now" as a datetime-local string, for the
  // input's min= attribute — stops picking a past time at the source
  // rather than only catching it after the fact.
  const nowLocalValue = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  const isPastSchedule =
    isScheduleMode && scheduledAt !== null && new Date(scheduledAt).getTime() <= Date.now();

  useEffect(() => {
    async function calculateReach() {
      setLoadingReach(true);
      try {
        const supabase = createClient();

        if (audience.type === 'all') {
          const { count } = await supabase
            .from('contacts')
            .select('*', { count: 'exact', head: true });
          setEstimatedReach(count ?? 0);
        } else if (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) {
          const { data: contactTags } = await supabase
            .from('contact_tags')
            .select('contact_id')
            .in('tag_id', audience.tagIds);

          const uniqueIds = new Set((contactTags ?? []).map((ct) => ct.contact_id));
          setEstimatedReach(uniqueIds.size);
        } else if (audience.type === 'csv' && audience.csvContacts) {
          setEstimatedReach(audience.csvContacts.length);
        } else {
          setEstimatedReach(0);
        }
      } finally {
        setLoadingReach(false);
      }
    }

    calculateReach();
  }, [audience]);

  const audienceLabel =
    audience.type === 'all'
      ? t('scheduleSend.audienceAll')
      : audience.type === 'tags'
        ? t('scheduleSend.audienceTags')
        : audience.type === 'csv'
          ? t('scheduleSend.audienceCsv')
          : t('scheduleSend.audienceField');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          {isScheduleMode ? t('scheduleSend.titleSchedule') : t('scheduleSend.titleSend')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {isScheduleMode ? t('scheduleSend.subtitleSchedule') : t('scheduleSend.subtitleSend')}
        </p>
      </div>

      {/* Broadcast Name */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">{t('scheduleSend.broadcastName')}</label>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('scheduleSend.broadcastNamePlaceholder')}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* Summary Card */}
      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
        <p className="text-sm font-medium text-foreground">{t('scheduleSend.summary')}</p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.template')}</p>
            <p className="text-foreground">{template.name}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.audience')}</p>
            <p className="text-foreground">{audienceLabel}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.estimatedReach')}</p>
            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              ) : (
                <>
                  <Users className="h-3.5 w-3.5 text-primary" />
                  <p className="font-medium text-foreground">{estimatedReach.toLocaleString()}</p>
                </>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.language')}</p>
            <p className="text-foreground">{template.language ?? 'en_US'}</p>
          </div>
        </div>
      </div>

      {/* Schedule toggle — AiSensy-style: flip it on right here to
          schedule instead of sending now, no separate entry point. */}
      <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card/50 p-4">
        <div>
          <p className="text-sm font-medium text-foreground">
            {t('scheduleSend.scheduleToggleLabel')}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('scheduleSend.scheduleToggleDesc')}
          </p>
        </div>
        <Switch
          checked={isScheduleMode}
          onCheckedChange={(checked) => onScheduledAtChange(checked ? nowLocalValue : null)}
          disabled={isProcessing}
        />
      </div>

      {/* Date/time picker — only shown once the toggle above is on. */}
      {isScheduleMode && (
        <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
          <div>
            <p className="text-sm font-medium text-foreground">{t('scheduleSend.scheduleSectionTitle')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('scheduleSend.scheduleSectionSubtitle')}
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-3">
            <div className="flex-1">
              <Label className="mb-1.5 block text-xs text-muted-foreground">
                {t('scheduleSend.scheduleDateLabel')} / {t('scheduleSend.scheduleTimeLabel')}
              </Label>
              <Input
                type="datetime-local"
                value={scheduledAt ?? nowLocalValue}
                min={nowLocalValue}
                onChange={(e) => onScheduledAtChange(e.target.value)}
                className="border-border bg-muted text-foreground"
              />
            </div>
          </div>
          {isPastSchedule && (
            <p className="text-xs text-red-400">{t('scheduleSend.schedulePastError')}</p>
          )}
        </div>
      )}

      {/* Processing overlay */}
      {isProcessing && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <p className="text-sm font-medium text-foreground">{t('scheduleSend.sending')}</p>
            </div>
            <span className="text-xs font-medium text-primary">{progress}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted">
            <div
              className="h-1.5 rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && (
            <Button
              variant="outline"
              onClick={onSaveDraft}
              disabled={!name.trim() || isProcessing}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {t('scheduleSend.saveDraft')}
            </Button>
          )}

          <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
          <DialogTrigger
            render={
              <Button
                disabled={!name.trim() || isProcessing || isPastSchedule}
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              />
            }
          >
            {isScheduleMode ? (
              <CalendarClock className="h-4 w-4" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            {isScheduleMode ? t('scheduleSend.scheduleCampaign') : t('scheduleSend.sendCampaign')}
          </DialogTrigger>
          <DialogContent className="border-border bg-popover sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                {isScheduleMode
                  ? t('scheduleSend.confirmScheduleTitle')
                  : t('scheduleSend.confirmTitle')}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {isScheduleMode
                  ? t.rich('scheduleSend.confirmScheduleDesc', {
                      count: estimatedReach,
                      template: template.name,
                      when: scheduledAt
                        ? new Date(scheduledAt).toLocaleString(undefined, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })
                        : '',
                      b: (chunks) => (
                        <span className="font-medium text-popover-foreground">{chunks}</span>
                      ),
                    })
                  : t.rich('scheduleSend.confirmDesc', {
                      count: estimatedReach,
                      template: template.name,
                      b: (chunks) => (
                        <span className="font-medium text-popover-foreground">{chunks}</span>
                      ),
                    })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowConfirm(false)}
                className="border-border text-muted-foreground"
              >
                {t('cancel')}
              </Button>
              <Button
                onClick={() => {
                  setShowConfirm(false);
                  onSend();
                }}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {isScheduleMode ? (
                  <CalendarClock className="h-4 w-4" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                {isScheduleMode ? t('scheduleSend.scheduleCampaign') : t('scheduleSend.sendCampaign')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        </div>
      </div>
    </div>
  );
}