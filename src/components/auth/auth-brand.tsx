/**
 * InnovateX Media brand block for the signed-out pages (login, signup,
 * forgot-password, reset-password). Replaces the generic chat-bubble
 * icon tile those pages inherited from the open-source template.
 *
 * Same two-logo trick the sidebar uses: the dark-mode artwork is the
 * default and the light variant swaps in under html[data-mode="light"],
 * so the navy "va" / "MEDIA" letters stay legible in either mode.
 */
export function AuthBrand() {
  return (
    <div className="mb-3 flex flex-col items-center gap-1.5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/innovatex-logo-dark.png"
        alt="InnovateX Media"
        className="block h-14 w-auto [html[data-mode=light]_&]:hidden"
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/innovatex-logo-light.png"
        alt="InnovateX Media"
        className="hidden h-14 w-auto [html[data-mode=light]_&]:block"
      />
      <span className="text-[11px] font-semibold leading-none tracking-[0.03em] text-foreground/75">
        WhatsApp CRM
      </span>
    </div>
  )
}