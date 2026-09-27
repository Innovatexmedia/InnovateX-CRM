'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ArrowLeft, Send, Loader2, Users, Save, CalendarClock, Zap, Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  formatTimeZoneLabel,
  getLocalTimeZone,
  listTimeZones,
  utcToZonedParts,
  zonedTimeToUtc,
} from '@/lib/timezone';

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
  /** A real UTC instant (ISO string), already timezone-corrected —
   *  ready to hand straight to the backend. `null` means "send now";
   *  this is the source of truth for which of the two mode cards is
   *  selected. */
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

  // scheduledAt is the single source of truth for which card is
  // selected: null = send now, a value = scheduled for then. It's
  // always a real UTC instant, so this comparison is correct no
  // matter which timezone was picked to build it.
  const isScheduleMode = scheduledAt !== null;
  const isPastSchedule =
    isScheduleMode && scheduledAt !== null && new Date(scheduledAt).getTime() <= Date.now();

  // The wall-clock date/time/timezone shown in the picker. These are
  // local UI state, not the source of truth — every change is
  // immediately converted to a real UTC instant via zonedTimeToUtc()
  // and pushed up through onScheduledAtChange. Defaults to the
  // browser's own timezone and "5 minutes from now" the first time
  // the user switches into schedule mode.
  const [timeZone, setTimeZone] = useState<string>(() => getLocalTimeZone());
  const [dateStr, setDateStr] = useState<string>(() =>
    utcToZonedParts(new Date(Date.now() + 5 * 60000), getLocalTimeZone()).date,
  );
  const [timeStr, setTimeStr] = useState<string>(() =>
    utcToZonedParts(new Date(Date.now() + 5 * 60000), getLocalTimeZone()).time,
  );
  // Defensively include the detected local zone even if the runtime's
  // IANA list uses a different canonical spelling for it, so the
  // <select> below never silently shows the wrong selected option.
  const timeZones = useState(() => {
    const zones = listTimeZones();
    const local = getLocalTimeZone();
    return zones.includes(local) ? zones : [local, ...zones];
  })[0];

  function applySchedule(nextDate: string, nextTime: string, nextTimeZone: string) {
    setDateStr(nextDate);
    setTimeStr(nextTime);
    setTimeZone(nextTimeZone);
    onScheduledAtChange(zonedTimeToUtc(nextDate, nextTime, nextTimeZone).toISOString());
  }

  function handlePickSendNow() {
    onScheduledAtChange(null);
  }

  function handlePickSchedule() {
    if (scheduledAt !== null) return; // already in schedule mode
    applySchedule(dateStr, timeStr, timeZone);
  }

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

      {/* When should this campaign be sent — two cards, right here in
          the final step, no separate entry point for scheduling. */}
      <div>
        <p className="text-sm font-medium text-foreground">{t('scheduleSend.sendModeQuestion')}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('scheduleSend.sendModeSubtitle')}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SendModeCard
          icon={<Zap className="h-5 w-5" />}
          title={t('scheduleSend.sendNowCardTitle')}
          description={t('scheduleSend.sendNowCardDesc')}
          selected={!isScheduleMode}
          disabled={isProcessing}
          onClick={handlePickSendNow}
        />
        <SendModeCard
          icon={<CalendarClock className="h-5 w-5" />}
          title={t('scheduleSend.scheduleCardTitle')}
          description={t('scheduleSend.scheduleCardDesc')}
          selected={isScheduleMode}
          disabled={isProcessing}
          onClick={handlePickSchedule}
        />
      </div>

      {/* Date/time/timezone picker — only shown once "Schedule for
          later" above is selected. */}
      {isScheduleMode && (
        <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
          <div>
            <p className="text-sm font-medium text-foreground">{t('scheduleSend.scheduleSectionTitle')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('scheduleSend.scheduleSectionSubtitle')}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <Label className="mb-1.5 block text-xs text-muted-foreground">
                {t('scheduleSend.scheduleDateLabel')}
              </Label>
              <Input
                type="date"
                value={dateStr}
                min={utcToZonedParts(new Date(), timeZone).date}
                disabled={isProcessing}
                onChange={(e) => applySchedule(e.target.value, timeStr, timeZone)}
                className="border-border bg-muted text-foreground"
              />
            </div>
            <div>
              <Label className="mb-1.5 block text-xs text-muted-foreground">
                {t('scheduleSend.scheduleTimeLabel')}
              </Label>
              <Input
                type="time"
                value={timeStr}
                disabled={isProcessing}
                onChange={(e) => applySchedule(dateStr, e.target.value, timeZone)}
                className="border-border bg-muted text-foreground"
              />
            </div>
            <div>
              <Label className="mb-1.5 block text-xs text-muted-foreground">
                {t('scheduleSend.timezoneLabel')}
              </Label>
              <select
                value={timeZone}
                disabled={isProcessing}
                onChange={(e) => applySchedule(dateStr, timeStr, e.target.value)}
                className="h-9 w-full rounded-md border border-border bg-muted px-3 text-sm text-foreground disabled:opacity-50"
              >
                {timeZones.map((tz) => (
                  <option key={tz} value={tz}>
                    {formatTimeZoneLabel(tz)}
                  </option>
                ))}
              </select>
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
                      // Formatted in the timezone the user actually
                      // picked, not the browser's own — otherwise a
                      // campaign scheduled for "2pm New York" would
                      // confusingly confirm as a different local time.
                      when: scheduledAt
                        ? new Date(scheduledAt).toLocaleString(undefined, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                            timeZone,
                          }) + ` (${formatTimeZoneLabel(timeZone)})`
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

/** One of the two "Send now" / "Schedule for later" selectable cards. */
function SendModeCard({
  icon,
  title,
  description,
  selected,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={`flex items-start gap-3 rounded-xl border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        selected
          ? 'border-primary bg-primary/5 ring-1 ring-primary'
          : 'border-border bg-card/50 hover:border-primary/40'
      }`}
    >
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
          selected ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'
        }`}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <div
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
          selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
        }`}
      >
        {selected && <Check className="h-3 w-3" />}
      </div>
    </button>
  );
}