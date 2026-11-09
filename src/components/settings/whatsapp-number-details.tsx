'use client';

import type { ReactNode } from 'react';
import {
  Phone,
  Store,
  Activity,
  Users,
  CalendarDays,
  Hash,
  Layers,
  ShieldCheck,
  CheckCircle2,
  Clock,
  XCircle,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import {
  displayNameStatusKind,
  messagingLimitCount,
} from '@/lib/whatsapp/business-profile';

/**
 * Live details of the connected number, straight from Meta's health check
 * (GET /api/whatsapp/config → phone_info). Shared by the Facebook summary
 * card and the manual-connect "Number details" card so both look and read
 * the same. Cells whose value Meta didn't return are simply left out.
 */

export interface NumberDetailsInfo {
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  messaging_limit_tier?: string;
  /** Review status of the live display name (APPROVED, DECLINED, …). */
  name_status?: string;
  /** A requested name still in review, and that request's status. */
  new_display_name?: string;
  new_name_status?: string;
}

function Cell({
  icon,
  label,
  children,
  aside,
  mono,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
  aside?: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 px-3 py-2.5">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd
          className={cn(
            'mt-0.5 truncate text-sm font-semibold text-foreground',
            mono && 'font-mono',
          )}
        >
          {children}
        </dd>
      </div>
      {aside}
    </div>
  );
}

export function WhatsAppNumberDetails({
  info,
  connectedSince,
  phoneNumberId,
  wabaId,
}: {
  info: NumberDetailsInfo | null;
  connectedSince: string | null;
  /** Shown only on the Facebook card (manual users see them in the form). */
  phoneNumberId?: string;
  wabaId?: string;
}) {
  const t = useTranslations('Settings.whatsapp');
  const icon = 'size-[18px]';

  const quality = (() => {
    switch (info?.quality_rating?.toUpperCase()) {
      case 'GREEN':
        return { label: t('connectedFbQualityHigh'), dot: 'bg-emerald-500' };
      case 'YELLOW':
        return { label: t('connectedFbQualityMedium'), dot: 'bg-amber-500' };
      case 'RED':
        return { label: t('connectedFbQualityLow'), dot: 'bg-red-500' };
      default:
        return null;
    }
  })();

  const limit = messagingLimitCount(info?.messaging_limit_tier);
  const limitLabel =
    limit === null
      ? null
      : limit === 'unlimited'
        ? t('limitUnlimited')
        : t('limitPerDay', { count: limit.toLocaleString() });

  // A name change waiting on Meta wins over the live name's status.
  const pendingName =
    displayNameStatusKind(info?.new_name_status) === 'pending'
      ? (info?.new_display_name ?? '')
      : null;
  const nameKind =
    pendingName !== null ? 'pending' : displayNameStatusKind(info?.name_status);

  const statusView = (() => {
    switch (nameKind) {
      case 'approved':
        return {
          text: t('nameStatusApproved'),
          cls: 'text-emerald-500',
          icon: <CheckCircle2 className="size-4" />,
        };
      case 'pending':
        return {
          text: t('nameStatusPending'),
          cls: 'text-amber-500',
          icon: <Clock className="size-4" />,
        };
      case 'declined':
        return {
          text: t('nameStatusDeclined'),
          cls: 'text-red-500',
          icon: <XCircle className="size-4" />,
        };
      default:
        return null;
    }
  })();

  return (
    <dl className="grid gap-2.5 sm:grid-cols-2">
      {info?.display_phone_number && (
        <Cell icon={<Phone className={icon} />} label={t('connectedFbNumber')}>
          {info.display_phone_number}
        </Cell>
      )}
      {info?.verified_name && (
        <Cell icon={<Store className={icon} />} label={t('connectedFbName')}>
          {info.verified_name}
        </Cell>
      )}
      {quality && (
        <Cell icon={<Activity className={icon} />} label={t('connectedFbQuality')}>
          <span className="inline-flex items-center gap-2">
            <span className={cn('size-2.5 rounded-full', quality.dot)} />
            {quality.label}
          </span>
        </Cell>
      )}
      {limitLabel && (
        <Cell
          icon={<Users className={icon} />}
          label={t('connectedFbLimit')}
          aside={
            info?.messaging_limit_tier ? (
              <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                {info.messaging_limit_tier}
              </span>
            ) : null
          }
        >
          {limitLabel}
        </Cell>
      )}
      {connectedSince && (
        <Cell icon={<CalendarDays className={icon} />} label={t('connectedFbSince')}>
          {connectedSince}
        </Cell>
      )}
      {phoneNumberId && (
        <Cell icon={<Hash className={icon} />} label={t('phoneNumberId')} mono>
          {phoneNumberId}
        </Cell>
      )}
      {wabaId && (
        <Cell icon={<Layers className={icon} />} label={t('wabaId')} mono>
          {wabaId}
        </Cell>
      )}
      {statusView && (
        <Cell
          icon={<ShieldCheck className={icon} />}
          label={t('nameStatus')}
        >
          <span className={cn('inline-flex items-center gap-1.5', statusView.cls)}>
            {statusView.icon}
            {statusView.text}
          </span>
          {pendingName && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {pendingName}
            </span>
          )}
        </Cell>
      )}
    </dl>
  );
}