'use client';

import { useTranslations } from 'next-intl';
import { EventCampaignWizard } from '@/components/events/event-campaign-wizard';

export default function NewEventCampaignPage() {
  const t = useTranslations('EventCampaign');
  return (
    <div>
      <div className="mx-auto max-w-3xl px-4 pt-4 sm:px-6 sm:pt-6">
        <h1 className="text-2xl font-bold text-foreground">{t('newTitle')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('newSubtitle')}</p>
      </div>
      <EventCampaignWizard />
    </div>
  );
}