'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Camera,
  Loader2,
  Plus,
  X,
  Clock,
  AlertTriangle,
  Store,
  Pencil,
  Info,
  MessageCircle,
  FileText,
  Mail,
  Link2,
  MapPin,
  Tag,
  CheckCircle2,
  XCircle,
  ExternalLink,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  EMPTY_PROFILE,
  PROFILE_LIMITS,
  PROFILE_VERTICALS,
  displayNameStatusKind,
  profilesEqual,
  validateProfile,
  type BusinessProfileFields,
  type ProfileErrors,
  type ProfileFieldError,
} from '@/lib/whatsapp/business-profile';

/**
 * Business Profile card — the public face of the connected WhatsApp number
 * (photo, about, description, address, email, websites, category) plus the
 * display-name change request. Rendered for numbers connected through
 * Facebook and manually; both go through /api/whatsapp/business-profile.
 *
 * Everyone on the account can see it; only admins (`canEdit`) can change
 * it — the API enforces the same rule.
 */

interface NumberInfo {
  display_phone_number?: string | null;
  verified_name?: string | null;
  name_status?: string | null;
  new_display_name?: string | null;
  new_name_status?: string | null;
}

interface ProfileResponse {
  profile: BusinessProfileFields & { profile_picture_url?: string | null };
  number: NumberInfo;
}

const PHOTO_SIZE = 640;

/** Centre-crop to a square and downscale to a JPEG (keeps uploads small). */
async function squarePhoto(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;
    const out = Math.min(PHOTO_SIZE, side);
    const canvas = document.createElement('canvas');
    canvas.width = out;
    canvas.height = out;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas');
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, out, out);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.9),
    );
    if (!blob) throw new Error('encode');
    return blob;
  } finally {
    bitmap.close();
  }
}

export function WhatsAppBusinessProfile({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations('Settings.whatsapp');

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saved, setSaved] = useState<BusinessProfileFields>(EMPTY_PROFILE);
  const [draft, setDraft] = useState<BusinessProfileFields>(EMPTY_PROFILE);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [number, setNumber] = useState<NumberInfo>({});
  const [errors, setErrors] = useState<ProfileErrors>({});
  const [saving, setSaving] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [nameOpen, setNameOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [nameBusy, setNameBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/whatsapp/business-profile');
      const data = (await res.json()) as ProfileResponse & { error?: string };
      if (!res.ok) throw new Error(data.error || t('bpLoadError'));
      const { profile_picture_url, ...fields } = data.profile;
      setSaved(fields);
      setDraft(fields);
      setPhotoUrl(profile_picture_url ?? null);
      setNumber(data.number ?? {});
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('bpLoadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
    // load only depends on the (stable) translator
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = !profilesEqual(draft, saved);

  function fieldError(e?: ProfileFieldError): string | null {
    if (!e) return null;
    switch (e.code) {
      case 'aboutRequired':
        return t('bpErrAboutRequired');
      case 'tooLong':
        return t('bpErrTooLong', { max: e.max ?? 0 });
      case 'email':
        return t('bpErrEmail');
      case 'website':
        return t('bpErrWebsite');
      case 'tooMany':
        return t('bpErrTooMany', { max: e.max ?? 0 });
    }
  }

  function set<K extends keyof BusinessProfileFields>(key: K, value: BusinessProfileFields[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => {
      if (!e[key]) return e;
      const next = { ...e };
      delete next[key];
      return next;
    });
  }

  function setWebsite(index: number, value: string) {
    const next = [...draft.websites];
    next[index] = value;
    set('websites', next);
  }

  async function handleSave() {
    const result = validateProfile(draft);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/whatsapp/business-profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result.value),
      });
      const data = (await res.json()) as {
        profile?: ProfileResponse['profile'];
        error?: string;
      };
      if (!res.ok || !data.profile) throw new Error(data.error || t('bpSaveFailed'));
      const { profile_picture_url, ...fields } = data.profile;
      setSaved(fields);
      setDraft(fields);
      setPhotoUrl(profile_picture_url ?? photoUrl);
      setErrors({});
      setEditing(false);
      setSavedAt(new Date());
      toast.success(t('bpSaved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('bpSaveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handlePhoto(file: File | undefined) {
    if (!file) return;
    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      toast.error(t('bpPhotoBadType'));
      return;
    }
    setPhotoBusy(true);
    try {
      const blob = await squarePhoto(file);
      const form = new FormData();
      form.append('photo', new File([blob], 'profile.jpg', { type: 'image/jpeg' }));
      const res = await fetch('/api/whatsapp/business-profile', {
        method: 'POST',
        body: form,
      });
      const data = (await res.json()) as {
        profile?: ProfileResponse['profile'];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || t('bpPhotoFail'));
      setPhotoUrl(data.profile?.profile_picture_url ?? photoUrl);
      toast.success(t('bpPhotoUpdated'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('bpPhotoFail'));
    } finally {
      setPhotoBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function handleNameSubmit() {
    const name = newName.trim();
    if (name.length < 3) {
      toast.error(t('bpNameTooShort'));
      return;
    }
    setNameBusy(true);
    try {
      const res = await fetch('/api/whatsapp/business-profile/display-name', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = (await res.json()) as { number?: NumberInfo; error?: string };
      if (!res.ok) throw new Error(data.error || t('bpNameFail'));
      setNumber((n) => ({ ...n, ...data.number }));
      setNameOpen(false);
      setNewName('');
      toast.success(t('bpNameSubmitted'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('bpNameFail'));
    } finally {
      setNameBusy(false);
    }
  }

  const livePending =
    displayNameStatusKind(number.new_name_status) === 'pending';
  const nameKind = livePending
    ? 'pending'
    : displayNameStatusKind(number.name_status);
  const readOnly = !canEdit;

  if (loading) {
    return (
      <Card className="gap-0 py-0">
        <CardContent className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('bpLoading')}
        </CardContent>
      </Card>
    );
  }

  if (loadError) {
    return (
      <Card className="gap-0 py-0">
        <CardContent className="space-y-3 p-6">
          <div className="flex items-start gap-2 text-sm text-muted-foreground">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
            <span>{loadError}</span>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {t('bpRetry')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const websites = draft.websites.length > 0 ? draft.websites : [''];
  const initial = (number.verified_name || '?').trim().charAt(0).toUpperCase();
  const categoryLabel = saved.vertical
    ? t(`bpCat.${saved.vertical}` as string)
    : null;

  const badge = (() => {
    switch (nameKind) {
      case 'approved':
        return {
          text: t('nameStatusApproved'),
          cls: 'bg-emerald-500/15 text-emerald-500',
          icon: <CheckCircle2 className="size-3.5" />,
        };
      case 'pending':
        return {
          text: t('nameStatusPending'),
          cls: 'bg-amber-500/15 text-amber-500',
          icon: <Clock className="size-3.5" />,
        };
      case 'declined':
        return {
          text: t('nameStatusDeclined'),
          cls: 'bg-red-500/15 text-red-500',
          icon: <XCircle className="size-3.5" />,
        };
      default:
        return null;
    }
  })();

  return (
    <Card className="gap-0 overflow-hidden py-0">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-4 border-b border-border bg-primary/5 px-6 py-4">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <Store className="size-6" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-semibold text-foreground">{t('bpTitle')}</h3>
          <p className="text-sm text-muted-foreground">
            {readOnly ? t('bpReadOnly') : t('bpSubtitle')}
          </p>
        </div>
        {!readOnly && !editing && (
          <Button variant="outline" onClick={() => setEditing(true)}>
            <Pencil className="mr-1.5 size-4" />
            {t('bpEdit')}
          </Button>
        )}
      </div>

      <CardContent className="space-y-5 p-6">
        {/* Hero: photo, name, status, category, about */}
        <div className="flex flex-wrap items-start gap-5">
          <div className="relative size-28 shrink-0">
            <div className="size-full overflow-hidden rounded-2xl border border-border bg-muted">
              {photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photoUrl} alt="" className="size-full object-cover" />
              ) : (
                <div className="flex size-full items-center justify-center text-4xl font-semibold text-muted-foreground">
                  {initial}
                </div>
              )}
              {photoBusy && (
                <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-background/70">
                  <Loader2 className="size-5 animate-spin" />
                </div>
              )}
            </div>
            {!readOnly && (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png"
                  className="hidden"
                  onChange={(e) => void handlePhoto(e.target.files?.[0])}
                />
                <button
                  type="button"
                  aria-label={t('bpPhotoChange')}
                  title={t('bpPhotoChange')}
                  disabled={photoBusy}
                  onClick={() => fileRef.current?.click()}
                  className="absolute -bottom-2 -right-2 flex size-9 items-center justify-center rounded-full border border-border bg-background text-foreground shadow hover:bg-muted disabled:opacity-50"
                >
                  <Camera className="size-4" />
                </button>
              </>
            )}
          </div>

          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-2xl font-bold text-foreground">
                {number.verified_name || '—'}
              </span>
              {badge && (
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium',
                    badge.cls,
                  )}
                >
                  {badge.icon}
                  {badge.text}
                </span>
              )}
            </div>
            {livePending && number.new_display_name && (
              <p className="text-xs text-muted-foreground">
                {t('bpNamePending', { name: number.new_display_name })}
              </p>
            )}
            {nameKind === 'declined' && number.new_display_name && (
              <p className="text-xs text-red-500">
                {t('bpNameDeclined', { name: number.new_display_name })}
              </p>
            )}
            {categoryLabel && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-3 py-1 text-sm text-foreground">
                <Tag className="size-3.5 text-primary" />
                {categoryLabel}
              </span>
            )}
            {saved.about && (
              <p className="text-sm text-foreground">{saved.about}</p>
            )}

            {!readOnly && !nameOpen && !livePending && (
              <button
                type="button"
                onClick={() => setNameOpen(true)}
                className="text-xs font-medium text-primary hover:underline"
              >
                {t('bpRequestChange')}
              </button>
            )}
            {!readOnly && nameOpen && (
              <div className="space-y-2 pt-1">
                <p className="text-xs text-muted-foreground">{t('bpDisplayNameHint')}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={newName}
                    maxLength={100}
                    placeholder={t('bpNewNamePlaceholder')}
                    onChange={(e) => setNewName(e.target.value)}
                    className="max-w-xs"
                  />
                  <Button size="sm" onClick={() => void handleNameSubmit()} disabled={nameBusy}>
                    {nameBusy && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                    {t('bpSubmitName')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setNameOpen(false);
                      setNewName('');
                    }}
                  >
                    {t('bpCancel')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>

        {!editing ? (
          <>
            {/* Business information (read view) */}
            <div className="rounded-2xl border border-border p-4">
              <div className="mb-3 flex items-center gap-2 text-base font-semibold text-foreground">
                <Info className="size-5 text-primary" />
                {t('bpInfoTitle')}
              </div>
              <div className="grid gap-2.5 md:grid-cols-2">
                <InfoRow icon={<MessageCircle className="size-[18px]" />} label={t('bpAbout')} value={saved.about} empty={t('bpNotSet')} />
                <InfoRow icon={<FileText className="size-[18px]" />} label={t('bpDescription')} value={saved.description} empty={t('bpNotSet')} />
                <InfoRow icon={<Mail className="size-[18px]" />} label={t('bpEmail')} value={saved.email} empty={t('bpNotSet')} />
                <InfoRow
                  icon={<Link2 className="size-[18px]" />}
                  label={t('bpWebsites')}
                  value={saved.websites.join(', ')}
                  empty={t('bpNotSet')}
                  href={saved.websites[0]}
                />
                <InfoRow icon={<MapPin className="size-[18px]" />} label={t('bpAddress')} value={saved.address} empty={t('bpNotSet')} />
                <InfoRow icon={<Tag className="size-[18px]" />} label={t('bpCategory')} value={categoryLabel ?? ''} empty={t('bpNotSet')} />
              </div>
            </div>

            {savedAt && (
              <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-500">
                  <CheckCircle2 className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground">{t('bpSavedTitle')}</p>
                  <p className="text-xs text-muted-foreground">{t('bpSavedDesc')}</p>
                </div>
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Clock className="size-3.5" />
                  {t('bpUpdatedAt', {
                    time: savedAt.toLocaleString(undefined, {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    }),
                  })}
                </span>
              </div>
            )}
          </>
        ) : (
          <>
            {/* Edit form */}
            <div className="grid gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="bp-about">{t('bpAbout')}</Label>
                <Input
                  id="bp-about"
                  value={draft.about}
                  maxLength={PROFILE_LIMITS.about}
                  onChange={(e) => set('about', e.target.value)}
                />
                <FieldFoot
                  error={fieldError(errors.about)}
                  hint={t('bpAboutHint')}
                  count={`${draft.about.length}/${PROFILE_LIMITS.about}`}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="bp-description">{t('bpDescription')}</Label>
                <Textarea
                  id="bp-description"
                  rows={4}
                  value={draft.description}
                  maxLength={PROFILE_LIMITS.description}
                  onChange={(e) => set('description', e.target.value)}
                />
                <FieldFoot
                  error={fieldError(errors.description)}
                  count={`${draft.description.length}/${PROFILE_LIMITS.description}`}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="bp-category">{t('bpCategory')}</Label>
                  <Select
                    value={draft.vertical || undefined}
                    onValueChange={(v) => set('vertical', v ?? '')}
                  >
                    <SelectTrigger id="bp-category" className="w-full">
                      <SelectValue placeholder={t('bpCategoryPlaceholder')}>
                        {draft.vertical
                          ? t(`bpCat.${draft.vertical}` as string)
                          : undefined}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {PROFILE_VERTICALS.map((v) => (
                        <SelectItem key={v} value={v}>
                          {t(`bpCat.${v}` as string)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="bp-email">{t('bpEmail')}</Label>
                  <Input
                    id="bp-email"
                    type="email"
                    value={draft.email}
                    maxLength={PROFILE_LIMITS.email}
                    onChange={(e) => set('email', e.target.value)}
                  />
                  <FieldFoot error={fieldError(errors.email)} />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="bp-address">{t('bpAddress')}</Label>
                <Input
                  id="bp-address"
                  value={draft.address}
                  maxLength={PROFILE_LIMITS.address}
                  onChange={(e) => set('address', e.target.value)}
                />
                <FieldFoot error={fieldError(errors.address)} />
              </div>

              <div className="space-y-1.5">
                <Label>{t('bpWebsites')}</Label>
                <div className="space-y-2">
                  {websites.map((w, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input
                        value={w}
                        placeholder="https://"
                        maxLength={PROFILE_LIMITS.website}
                        onChange={(e) => setWebsite(i, e.target.value)}
                      />
                      {websites.length > 1 && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('bpRemoveWebsite')}
                          onClick={() =>
                            set(
                              'websites',
                              draft.websites.filter((_, idx) => idx !== i),
                            )
                          }
                        >
                          <X className="size-4" />
                        </Button>
                      )}
                    </div>
                  ))}
                  {websites.length < PROFILE_LIMITS.websites && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => set('websites', [...websites, ''])}
                    >
                      <Plus className="mr-1 size-4" />
                      {t('bpAddWebsite')}
                    </Button>
                  )}
                </div>
                <FieldFoot error={fieldError(errors.websites)} />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => void handleSave()} disabled={!dirty || saving}>
                {saving && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                {t('bpSave')}
              </Button>
              <Button
                variant="ghost"
                disabled={saving}
                onClick={() => {
                  setDraft(saved);
                  setErrors({});
                  setEditing(false);
                }}
              >
                {t('bpCancel')}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function InfoRow({
  icon,
  label,
  value,
  empty,
  href,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  empty: string;
  href?: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 px-3 py-2.5">
      <span className="shrink-0 text-primary">{icon}</span>
      <span className="w-24 shrink-0 text-sm font-semibold text-foreground">{label}</span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-sm',
          value ? 'text-foreground' : 'text-muted-foreground',
        )}
        title={value || undefined}
      >
        {value || empty}
      </span>
      {href && value && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={href}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="size-4" />
        </a>
      )}
    </div>
  );
}

function FieldFoot({
  error,
  hint,
  count,
}: {
  error?: string | null;
  hint?: string;
  count?: string;
}) {
  if (!error && !hint && !count) return null;
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className={error ? 'text-red-500' : 'text-muted-foreground'}>{error ?? hint}</span>
      {count && <span className="shrink-0 text-muted-foreground">{count}</span>}
    </div>
  );
}