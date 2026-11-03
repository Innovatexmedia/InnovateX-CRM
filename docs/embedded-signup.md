# WhatsApp Embedded Signup ("Connect with Facebook")

Settings → WhatsApp offers two ways to connect: **Connect with Facebook**
(Meta's Embedded Signup popup) and **Connect manually** (the original form,
unchanged).

## Environment variables

| Variable | Where | Value |
| --- | --- | --- |
| `NEXT_PUBLIC_META_ES_APP_ID` | browser + server | App ID of the Tech Provider Meta app |
| `NEXT_PUBLIC_META_ES_CONFIG_ID` | browser | Facebook Login for Business **Configuration ID** (Embedded Signup) |
| `META_ES_APP_SECRET` | server only | App Secret of that app. Also accepted for webhook signature checks |

Without them the Facebook option shows "not configured" and manual connect keeps working.
`NEXT_PUBLIC_*` values are baked in at build time — redeploy after changing them.

## Meta app checklist

- Facebook Login for Business: Client OAuth login, Web OAuth login, Enforce HTTPS,
  Embedded Browser OAuth Login, Login with the JavaScript SDK = **On**.
- Allowed Domains for the JavaScript SDK + Valid OAuth Redirect URIs: production domain
  (and the ngrok domain while testing).
- App in **Live** mode; Advanced access for `whatsapp_business_management` and
  `whatsapp_business_messaging`.
- Webhook callback (one per app) stays on **production**: `https://<prod>/api/whatsapp/webhook`,
  fields `messages` and `account_update`. Never point it at ngrok.
- Customers need a payment method on their WABA; unverified providers are limited
  (≈10 new customers / 7 days).

## What happens on connect

1. Popup returns a one-time `code` (~30 s) and the `phone_number_id` / `waba_id` (postMessage).
2. `POST /api/whatsapp/embedded-signup` (admin only) exchanges the code, verifies the number
   belongs to the WABA, registers it with a generated PIN (stored encrypted in
   `whatsapp_config.two_step_pin`; skipped for WhatsApp Business app numbers), subscribes the
   WABA to the app, and saves the row with `connected_via = 'embedded_signup'`.

If the token later stops working, use **Connect with Facebook** again (reconnect).

## Deploy order

1. Run `supabase/migrations/052_whatsapp_embedded_signup.sql` (additive, safe on live DB).
2. Set the three env vars in Vercel.
3. Deploy.

## Test locally with ngrok

Run `ngrok http 3000`, add the ngrok domain to Allowed Domains / Redirect URIs, open the CRM
via the ngrok URL, and connect. Local and prod share one Supabase DB, so the saved connection is
live for production too.