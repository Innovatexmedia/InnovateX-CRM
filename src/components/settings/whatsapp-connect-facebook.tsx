'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, AlertTriangle, Info, ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { BrandMark } from './brand-mark';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  FB_SDK_VERSION,
  isFacebookOrigin,
  parseEmbeddedSignupMessage,
  type EmbeddedSignupSession,
} from '@/lib/whatsapp/embedded-signup';

// Public (browser) half of the Embedded Signup config. The App Secret
// lives on the server only (META_ES_APP_SECRET).
const ES_APP_ID = (process.env.NEXT_PUBLIC_META_ES_APP_ID ?? '').trim();
const ES_CONFIG_ID = (process.env.NEXT_PUBLIC_META_ES_CONFIG_ID ?? '').trim();

/** True when both public ids are present. The server route additionally
 *  needs META_ES_APP_SECRET and answers 503 `not_configured` without it. */
export const isEmbeddedSignupConfigured =
  /^\d+$/.test(ES_APP_ID) && /^\d+$/.test(ES_CONFIG_ID);

interface FacebookLoginResponse {
  authResponse?: { code?: string } | null;
  status?: string;
}
interface FacebookSdk {
  init: (params: Record<string, unknown>) => void;
  login: (
    callback: (response: FacebookLoginResponse) => void,
    options: Record<string, unknown>,
  ) => void;
}
declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

let sdkPromise: Promise<FacebookSdk> | null = null;

/** Load + init the Facebook JS SDK once per page. */
function loadFacebookSdk(appId: string): Promise<FacebookSdk> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<FacebookSdk>((resolve, reject) => {
    const init = () => {
      if (!window.FB) {
        reject(new Error('Facebook SDK missing after load'));
        return;
      }
      window.FB.init({
        appId,
        autoLogAppEvents: true,
        xfbml: true,
        version: FB_SDK_VERSION,
      });
      resolve(window.FB);
    };
    if (window.FB) {
      init();
      return;
    }
    window.fbAsyncInit = init;
    const script = document.createElement('script');
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => reject(new Error('Facebook SDK failed to load'));
    document.body.appendChild(script);
  });
  // Allow a retry after a failed load (ad blocker, offline, …).
  sdkPromise.catch(() => {
    sdkPromise = null;
  });
  return sdkPromise;
}

// How long to wait for the popup's FINISH message after the code arrives.
const SESSION_WAIT_MS = 4000;

type Phase = 'idle' | 'popup' | 'saving';

interface ServerError {
  message: string;
  detail: string | null;
}

export function WhatsAppConnectFacebook({
  onConnected,
}: {
  onConnected: () => void | Promise<void>;
}) {
  const t = useTranslations('Settings.whatsapp');
  const [sdkReady, setSdkReady] = useState(false);
  const [sdkFailed, setSdkFailed] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<ServerError | null>(null);

  const codeRef = useRef<string | null>(null);
  const sessionRef = useRef<EmbeddedSignupSession | null>(null);
  const submittedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onConnectedRef = useRef(onConnected);
  useEffect(() => {
    onConnectedRef.current = onConnected;
  }, [onConnected]);

  // Preload the SDK. setState only in promise callbacks.
  useEffect(() => {
    if (!isEmbeddedSignupConfigured) return;
    let cancelled = false;
    loadFacebookSdk(ES_APP_ID)
      .then(() => {
        if (!cancelled) setSdkReady(true);
      })
      .catch(() => {
        if (!cancelled) setSdkFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const reset = useCallback(() => {
    codeRef.current = null;
    sessionRef.current = null;
    submittedRef.current = false;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setPhase('idle');
  }, []);

  const submit = useCallback(async () => {
    const code = codeRef.current;
    const session = sessionRef.current;
    if (!code || !session || submittedRef.current) return;
    submittedRef.current = true;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setPhase('saving');
    setError(null);
    try {
      const res = await fetch('/api/whatsapp/embedded-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          phone_number_id: session.phoneNumberId,
          waba_id: session.wabaId,
          business_id: session.businessId,
          event: session.event,
        }),
      });
      const payload = await res.json().catch(() => ({}));

      if (res.ok && payload.success) {
        toast.success(t('fbConnected'));
        await onConnectedRef.current();
        return;
      }
      if (res.ok && payload.saved) {
        // Saved, but Meta refused /register — Settings shows the reason.
        toast.error(t('fbRegistrationFailed'));
        setError({
          message: payload.registration_error || payload.error || t('fbRegistrationFailed'),
          detail: formatMeta(payload.meta),
        });
        await onConnectedRef.current();
        return;
      }
      setError({
        message: payload.error || t('fbFailed'),
        detail: formatMeta(payload.meta),
      });
    } catch (err) {
      console.error('Embedded Signup submit failed:', err);
      setError({ message: t('fbFailed'), detail: null });
    } finally {
      reset();
    }
  }, [reset, t]);

  // Popup → page messages (phone number + WABA ids).
  useEffect(() => {
    if (!isEmbeddedSignupConfigured) return;
    const onMessage = (event: MessageEvent) => {
      if (!isFacebookOrigin(event.origin)) return;
      const msg = parseEmbeddedSignupMessage(event.data);
      if (!msg) return;

      if (msg.kind === 'finish') {
        sessionRef.current = msg.session;
        if (codeRef.current) void submit();
      } else if (msg.kind === 'incomplete') {
        toast.error(t('fbIncomplete'));
        reset();
      } else {
        if (!submittedRef.current) {
          toast.error(msg.errorMessage || t('fbCancelled'));
          reset();
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [submit, reset, t]);

  useEffect(() => () => clearTimer(), []);

  function handleClick() {
    if (!window.FB || phase !== 'idle') return;
    setError(null);
    codeRef.current = null;
    sessionRef.current = null;
    submittedRef.current = false;
    setPhase('popup');

    // FB.login requires a plain (non-async) callback.
    window.FB.login(
      (response) => {
        const code = response.authResponse?.code;
        if (!code) {
          // Closed / denied before finishing.
          if (!submittedRef.current && !sessionRef.current) {
            toast.error(t('fbCancelled'));
            reset();
          }
          return;
        }
        codeRef.current = code;
        if (sessionRef.current) {
          void submit();
          return;
        }
        // Code arrived first; the FINISH message normally follows within
        // moments. Give up after a short wait.
        clearTimer();
        timerRef.current = setTimeout(() => {
          if (!sessionRef.current && !submittedRef.current) {
            toast.error(t('fbNoSession'));
            reset();
          }
        }, SESSION_WAIT_MS);
      },
      {
        config_id: ES_CONFIG_ID,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {} },
      },
    );
  }

  if (!isEmbeddedSignupConfigured) {
    return (
      <Alert>
        <Info className="h-4 w-4" />
        <AlertTitle>{t('fbNotConfiguredTitle')}</AlertTitle>
        <AlertDescription>{t('fbNotConfiguredDesc')}</AlertDescription>
      </Alert>
    );
  }

  const busy = phase !== 'idle';

  return (
    <div className="flex flex-col items-center space-y-4">
      {error && (
        <Alert variant="destructive" className="text-left">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t('fbFailedTitle')}</AlertTitle>
          <AlertDescription>
            <p>{error.message}</p>
            {error.detail && (
              <p className="mt-1 font-mono text-xs opacity-80">{error.detail}</p>
            )}
          </AlertDescription>
        </Alert>
      )}

      {sdkFailed && (
        <Alert variant="destructive" className="text-left">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{t('fbSdkFailed')}</AlertDescription>
        </Alert>
      )}

      <Button
        type="button"
        size="lg"
        onClick={handleClick}
        disabled={!sdkReady || busy}
        className="h-16 w-full max-w-md rounded-xl bg-gradient-to-r from-primary to-primary/75 px-8 text-lg font-semibold text-primary-foreground shadow-lg shadow-primary/40 transition-opacity hover:opacity-90 sm:min-w-[26rem]"
      >
        {busy ? (
          <Loader2 className="mr-2.5 h-5 w-5 animate-spin" />
        ) : (
          <BrandMark srcs={['/brand/facebook.svg', '/brand/facebook.png', '/brand/facebook.webp']} alt="" className="mr-3 size-8" />
        )}
        {phase === 'saving'
          ? t('fbConnecting')
          : phase === 'popup'
            ? t('fbWaitingPopup')
            : t('fbButton')}
        {!busy && <ArrowRight className="ml-3 h-6 w-6" />}
      </Button>

      <p className="max-w-md text-balance text-center text-sm text-foreground/60">
        <Info className="mr-2 inline-block size-4 align-[-3px]" />
        {t('fbHint')}
      </p>
    </div>
  );
}

function formatMeta(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object') return null;
  const m = meta as {
    step?: string | null;
    code?: number | null;
    subcode?: number | null;
    fbtrace_id?: string | null;
  };
  const parts = [
    m.step ? `step=${m.step}` : null,
    m.code != null ? `code=${m.code}` : null,
    m.subcode != null ? `subcode=${m.subcode}` : null,
    m.fbtrace_id ? `trace=${m.fbtrace_id}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}