"use client";

import { useState, useEffect, useCallback } from "react";
import { Sparkles, Hand, Undo2, Loader2, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useAuth } from "@/hooks/use-auth";

// ------------------------------------------------------------
// Account AI status is the same for every conversation, so cache it per
// account and reuse it across thread switches instead of hitting
// /api/ai/config every time the agent opens a chat.
//
// Keyed by accountId (a multi-account user switching workspaces must not
// see the previous account's status), and only *successful* fetches are
// cached — a transient failure returns a default without poisoning the
// cache, so it retries on the next thread open rather than hiding the
// banner for the whole session.
//
// Short TTL, not "forever until reload": `hasConflictingAutomation`
// depends on state an agent can change from several other screens
// (Automations list, an automation's edit page, Settings → AI
// Assistant) that have no way to reach into this module and invalidate
// it. Wiring an explicit invalidation call from every one of those
// mutation points would be fragile and easy to miss a spot on next
// time someone adds one. A short TTL makes the banner self-heal within
// a bounded window instead — the agent doesn't have to know to refresh
// the tab for it to catch up.
// ------------------------------------------------------------
const STATUS_TTL_MS = 15_000;

interface AiAccountStatus {
  autoReplyOn: boolean;
  /** An active `New message received` automation matches every inbound,
   *  so — even though `autoReplyOn` is true — the bot never actually
   *  gets a turn on ANY conversation. Surfacing this here is what keeps
   *  the "replying automatically" banner from lying to the agent, the
   *  same conflict Settings → AI Assistant already warns about. See
   *  `has_conflicting_automation` on GET /api/ai/config. */
  hasConflictingAutomation: boolean;
}
interface CachedStatus extends AiAccountStatus {
  fetchedAt: number;
}
const statusCache = new Map<string, CachedStatus>();

async function fetchAiAccountStatus(accountId: string): Promise<AiAccountStatus> {
  const cached = statusCache.get(accountId);
  if (cached && Date.now() - cached.fetchedAt < STATUS_TTL_MS) return cached;
  try {
    const res = await fetch("/api/ai/config", { cache: "no-store" });
    if (!res.ok)
      return { autoReplyOn: false, hasConflictingAutomation: false }; // don't cache a transient failure
    const j = await res.json();
    const status: CachedStatus = {
      // AI auto-reply is "live" only when configured, the master switch
      // is on, and the inbound bot is enabled.
      autoReplyOn: !!(j?.configured && j?.is_active && j?.auto_reply_enabled),
      hasConflictingAutomation: !!j?.has_conflicting_automation,
      fetchedAt: Date.now(),
    };
    statusCache.set(accountId, status);
    return status;
  } catch {
    return { autoReplyOn: false, hasConflictingAutomation: false }; // don't cache
  }
}

interface AiThreadBannerProps {
  conversationId: string;
  /** `conversations.ai_autoreply_disabled` — bot paused on this thread. */
  disabled: boolean;
  /** `conversations.ai_handoff_summary` — note the bot left on handoff. */
  handoffSummary?: string | null;
  /** Current assignee; when a human owns the thread the bot won't run,
   *  so the "AI active" banner is suppressed. */
  assignedAgentId?: string | null;
  /** The acting agent — "Take over" assigns the thread to them. */
  currentUserId?: string | null;
  /** Called after a successful toggle so the parent can patch its local
   *  conversation state (the realtime UPDATE also arrives, but this keeps
   *  the banner instant). */
  onChange?: (patch: {
    ai_autoreply_disabled: boolean;
    assigned_agent_id?: string | null;
  }) => void;
}

/**
 * Inbox banner that surfaces + controls the AI auto-reply bot per
 * conversation:
 *   - bot active here → "AI is replying automatically" + [Take over]
 *   - bot paused here → the handoff note (if any) + [Resume AI]
 * Renders nothing when the account has no auto-reply configured, or when
 * the bot is active but a human already owns the thread (nothing to do).
 */
export function AiThreadBanner({
  conversationId,
  disabled,
  handoffSummary,
  assignedAgentId,
  currentUserId,
  onChange,
}: AiThreadBannerProps) {
  const t = useTranslations("Inbox.aiBanner");
  const { accountId } = useAuth();
  const [autoReplyOn, setAutoReplyOn] = useState<boolean | null>(null);
  const [hasConflictingAutomation, setHasConflictingAutomation] = useState(false);
  const [busy, setBusy] = useState(false);
  // Optimistic local mirror of the pause flag so the banner flips
  // instantly on click; re-seeds whenever the thread (or its server
  // state via realtime) changes.
  const [paused, setPaused] = useState(disabled);
  useEffect(() => setPaused(disabled), [conversationId, disabled]);

  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    const load = () => {
      fetchAiAccountStatus(accountId).then((s) => {
        if (!alive) return;
        setAutoReplyOn(s.autoReplyOn);
        setHasConflictingAutomation(s.hasConflictingAutomation);
      });
    };
    load();
    // This component is never unmounted on a thread switch (MessageThread
    // reuses one instance and just changes props), and an agent can sit
    // in the same conversation for a while — so relying on a dependency
    // change (conversationId, account switch) to re-trigger the fetch
    // left the banner stuck on whatever it first loaded until something
    // happened to remount it. Polling on the same cadence as the TTL
    // above is what actually makes the cache short-lived instead of just
    // theoretically short-lived: the banner catches up to an automation
    // toggled off, or the AI config changed, within ~15s no matter what
    // the agent does in the meantime.
    const interval = setInterval(load, STATUS_TTL_MS);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [accountId]);

  const toggle = useCallback(
    async (paused: boolean) => {
      setBusy(true);
      try {
        const res = await fetch(`/api/ai/autoreply/${conversationId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // "Take over" also assigns the thread to the acting agent.
          body: JSON.stringify({ paused, assign_to_me: paused }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          toast.error(j?.error ?? t("updateError"));
          return;
        }
        setPaused(paused);
        onChange?.({
          ai_autoreply_disabled: paused,
          // Take over assigns to the acting agent; resume releases only
          // the caller's own assignment. The realtime UPDATE reconciles
          // the exact value either way.
          ...(paused
            ? currentUserId
              ? { assigned_agent_id: currentUserId }
              : {}
            : { assigned_agent_id: null }),
        });
        toast.success(paused ? t("tookOver") : t("resumed"));
      } catch {
        toast.error(t("networkError"));
      } finally {
        setBusy(false);
      }
    },
    [conversationId, currentUserId, onChange, t],
  );

  // Account has no auto-reply → nothing to show. (Still loading → nothing.)
  if (!autoReplyOn) return null;

  // Paused here (a human took over, or the model handed off).
  if (paused) {
    return (
      <Banner tone="muted">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">{t("pausedTitle")}</p>
          {handoffSummary && (
            <p className="truncate text-muted-foreground" title={handoffSummary}>
              {handoffSummary}
            </p>
          )}
        </div>
        <BannerButton onClick={() => toggle(false)} busy={busy} icon={Undo2}>
          {t("resume")}
        </BannerButton>
      </Banner>
    );
  }

  // Active, but a human already owns it → the bot won't fire; no banner.
  if (assignedAgentId) return null;

  // Configured and enabled, but an account-wide `New message received`
  // automation intercepts every inbound before the bot ever sees it (see
  // `has_conflicting_automation` on GET /api/ai/config). Telling the
  // agent "AI is replying automatically" here would be actively wrong —
  // it never will, on this thread or any other, until that automation is
  // turned off. Show the real state instead of a false "Take over".
  if (hasConflictingAutomation) {
    return (
      <Banner tone="warning">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <TriangleAlert className="h-3.5 w-3.5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="truncate font-medium text-foreground">
            {t("blockedByAutomation")}
          </span>
        </div>
      </Banner>
    );
  }

  // Active on this thread.
  return (
    <Banner tone="primary">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <Sparkles className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
        <span className="truncate font-medium text-foreground">
          {t("activeText")}
        </span>
      </div>
      <BannerButton onClick={() => toggle(true)} busy={busy} icon={Hand}>
        {t("takeOver")}
      </BannerButton>
    </Banner>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "primary" | "muted" | "warning";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b px-3 py-2 text-xs sm:px-4",
        tone === "primary" && "border-primary/20 bg-primary/5",
        tone === "muted" && "border-border bg-muted/40",
        tone === "warning" && "border-amber-500/30 bg-amber-500/10",
      )}
    >
      {children}
    </div>
  );
}

function BannerButton({
  onClick,
  busy,
  icon: Icon,
  children,
}: {
  onClick: () => void;
  busy: boolean;
  icon: typeof Hand;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Icon className="h-3 w-3" />
      )}
      {children}
    </button>
  );
}