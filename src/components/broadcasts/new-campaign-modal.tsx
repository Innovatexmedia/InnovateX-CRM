'use client';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Megaphone, Code, RefreshCw, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface NewCampaignModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Which entry the user picked. 'now' opens the broadcast wizard
   *  (which now has its own Send Now / Schedule toggle on the final
   *  step, AiSensy-style — there's no separate "Schedule" entry point
   *  any more); 'api' opens the API-campaign dialog. This component
   *  carries no send/schedule logic of its own. */
  onChoose: (mode: 'now' | 'api') => void;
}

/**
 * Campaign-type selection screen. Three cards, each with its own fixed
 * accent (not the theme accent) so "Broadcast" never reads as a
 * destructive red action whatever accent color the account chose.
 * "Recurring" is shown but not yet available.
 */
export function NewCampaignModal({ open, onOpenChange, onChoose }: NewCampaignModalProps) {
  const t = useTranslations('Broadcasts.newCampaignModal');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-[960px]">
        <DialogHeader>
          <DialogTitle className="text-2xl text-popover-foreground">{t('title')}</DialogTitle>
          <DialogDescription className="text-base text-muted-foreground">
            {t('subtitle')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4 pt-2 sm:grid-cols-3">
          <OptionCard
            icon={<Megaphone className="h-7 w-7" />}
            tone="emerald"
            title={t('sendNowTitle')}
            description={t('sendNowDesc')}
            badge={t('sendNowBadge')}
            onClick={() => onChoose('now')}
          />
          <OptionCard
            icon={<Code className="h-7 w-7" />}
            tone="amber"
            title={t('apiTitle')}
            description={t('apiDesc')}
            badge={t('apiBadge')}
            onClick={() => onChoose('api')}
          />
          <OptionCard
            icon={<RefreshCw className="h-7 w-7" />}
            tone="violet"
            title={t('recurringTitle')}
            description={t('recurringDesc')}
            badge={t('recurringBadge')}
            comingSoon={t('comingSoon')}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Full class names (not interpolated) so Tailwind can see them.
const TONES = {
  emerald: {
    card: 'border-emerald-500/40 bg-gradient-to-br from-emerald-500/10 to-transparent hover:border-emerald-400/70 hover:shadow-emerald-500/10',
    icon: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
    badge: 'bg-emerald-500/10 text-emerald-400',
    arrow: 'border-emerald-500/40 text-emerald-300',
  },
  amber: {
    card: 'border-amber-500/40 bg-gradient-to-br from-amber-500/10 to-transparent hover:border-amber-400/70 hover:shadow-amber-500/10',
    icon: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
    badge: 'bg-amber-500/10 text-amber-400',
    arrow: 'border-amber-500/40 text-amber-300',
  },
  blue: {
    card: 'border-blue-500/40 bg-gradient-to-br from-blue-500/10 to-transparent hover:border-blue-400/70 hover:shadow-blue-500/10',
    icon: 'border-blue-500/30 bg-blue-500/10 text-blue-400',
    badge: 'bg-blue-500/10 text-blue-400',
    arrow: 'border-blue-500/40 text-blue-300',
  },
  violet: {
    card: 'border-violet-500/30 bg-gradient-to-br from-violet-500/10 to-transparent',
    icon: 'border-violet-500/30 bg-violet-500/10 text-violet-400',
    badge: 'bg-violet-500/10 text-violet-400',
    arrow: 'border-violet-500/40 text-violet-300',
  },
} as const;

function OptionCard({
  icon,
  tone,
  title,
  description,
  badge,
  onClick,
  comingSoon,
}: {
  icon: React.ReactNode;
  tone: keyof typeof TONES;
  title: string;
  description: string;
  badge: string;
  onClick?: () => void;
  /** When set, the card is inert and shows this pill (e.g. "Coming soon"). */
  comingSoon?: string;
}) {
  const c = TONES[tone];
  const disabled = !!comingSoon;

  const body = (
    <>
      <div className="flex w-full items-start justify-between">
        <div className={`flex h-14 w-14 items-center justify-center rounded-xl border ${c.icon}`}>
          {icon}
        </div>
        {comingSoon ? (
          <span className={`rounded-full border px-3 py-1 text-xs font-medium uppercase ${c.arrow}`}>
            {comingSoon}
          </span>
        ) : (
          <span
            className={`flex h-10 w-10 items-center justify-center rounded-full border transition-transform group-hover:translate-x-1 ${c.arrow}`}
          >
            <ChevronRight className="h-5 w-5" />
          </span>
        )}
      </div>

      <div>
        <span
          className={`mb-2 inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${c.badge}`}
        >
          {badge}
        </span>
        <p className="text-lg font-semibold text-foreground">{title}</p>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>
    </>
  );

  const base = `group flex flex-col items-start gap-4 rounded-2xl border p-6 text-left transition-all ${c.card}`;

  if (disabled) {
    return (
      <div aria-disabled="true" className={`${base} cursor-not-allowed opacity-60`}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${base} hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-popover`}
    >
      {body}
    </button>
  );
}