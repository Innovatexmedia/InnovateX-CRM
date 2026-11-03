import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isFacebookOrigin,
  parseEmbeddedSignupMessage,
  parseEmbeddedSignupRequest,
} from "./embedded-signup";
import {
  generateRegistrationPin,
  getEmbeddedSignupServerEnv,
} from "./embedded-signup-server";
import { exchangeEmbeddedSignupCode } from "./meta-api";

describe("isFacebookOrigin", () => {
  it("accepts facebook.com and its subdomains over https", () => {
    expect(isFacebookOrigin("https://www.facebook.com")).toBe(true);
    expect(isFacebookOrigin("https://business.facebook.com")).toBe(true);
    expect(isFacebookOrigin("https://facebook.com")).toBe(true);
  });
  it("rejects lookalikes, http and garbage", () => {
    expect(isFacebookOrigin("https://evilfacebook.com")).toBe(false);
    expect(isFacebookOrigin("https://facebook.com.evil.io")).toBe(false);
    expect(isFacebookOrigin("http://www.facebook.com")).toBe(false);
    expect(isFacebookOrigin("not a url")).toBe(false);
  });
});

describe("parseEmbeddedSignupMessage", () => {
  const msg = (event: string, data: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event, data });

  it("parses a FINISH message", () => {
    expect(
      parseEmbeddedSignupMessage(
        msg("FINISH", { phone_number_id: "111", waba_id: "222", business_id: "333" }),
      ),
    ).toEqual({
      kind: "finish",
      session: { phoneNumberId: "111", wabaId: "222", businessId: "333", event: "FINISH" },
    });
  });
  it("treats FINISH without ids and WABA-only finishes as incomplete", () => {
    expect(parseEmbeddedSignupMessage(msg("FINISH"))?.kind).toBe("incomplete");
    expect(parseEmbeddedSignupMessage(msg("FINISH_ONLY_WABA"))?.kind).toBe("incomplete");
  });
  it("maps CANCEL and ERROR to cancel", () => {
    expect(
      parseEmbeddedSignupMessage(msg("CANCEL", { current_step: "PHONE" })),
    ).toEqual({ kind: "cancel", step: "PHONE", errorMessage: null });
    expect(parseEmbeddedSignupMessage(msg("ERROR", { error_message: "x" }))?.kind).toBe("cancel");
  });
  it("ignores unrelated or malformed messages", () => {
    expect(parseEmbeddedSignupMessage("nope")).toBeNull();
    expect(parseEmbeddedSignupMessage(JSON.stringify({ type: "other" }))).toBeNull();
    expect(parseEmbeddedSignupMessage(null)).toBeNull();
  });
});

describe("parseEmbeddedSignupRequest", () => {
  const ok = { code: "abc", phone_number_id: "111", waba_id: "222" };
  it("accepts a valid body and defaults the event", () => {
    const r = parseEmbeddedSignupRequest(ok);
    expect(r).toEqual({
      ok: true,
      value: { code: "abc", phoneNumberId: "111", wabaId: "222", businessId: null, event: "FINISH" },
    });
  });
  it("names the offending field", () => {
    expect(parseEmbeddedSignupRequest({ ...ok, code: "" })).toMatchObject({ ok: false, field: "code" });
    expect(parseEmbeddedSignupRequest({ ...ok, phone_number_id: "1a" })).toMatchObject({
      ok: false,
      field: "phone_number_id",
    });
    expect(parseEmbeddedSignupRequest({ ...ok, waba_id: undefined })).toMatchObject({
      ok: false,
      field: "waba_id",
    });
    expect(parseEmbeddedSignupRequest({ ...ok, event: "CANCEL" })).toMatchObject({
      ok: false,
      field: "event",
    });
  });
  it("accepts the Business app onboarding event", () => {
    const r = parseEmbeddedSignupRequest({ ...ok, event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" });
    expect(r.ok).toBe(true);
  });
});

describe("getEmbeddedSignupServerEnv / generateRegistrationPin", () => {
  it("needs a numeric app id and a secret", () => {
    expect(getEmbeddedSignupServerEnv({})).toBeNull();
    expect(
      getEmbeddedSignupServerEnv({ NEXT_PUBLIC_META_ES_APP_ID: "abc", META_ES_APP_SECRET: "s" }),
    ).toBeNull();
    expect(
      getEmbeddedSignupServerEnv({ NEXT_PUBLIC_META_ES_APP_ID: "123", META_ES_APP_SECRET: " s " }),
    ).toEqual({ appId: "123", appSecret: "s" });
  });
  it("generates 6-digit PINs", () => {
    for (let i = 0; i < 50; i++) expect(generateRegistrationPin()).toMatch(/^\d{6}$/);
  });
});

describe("exchangeEmbeddedSignupCode", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the access token and sends no redirect_uri", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ access_token: "tok", expires_in: 100 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await exchangeEmbeddedSignupCode({ appId: "1", appSecret: "s", code: "c" });
    expect(r.accessToken).toBe("tok");
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("/oauth/access_token");
    expect(url).toContain("code=c");
    expect(url).not.toContain("redirect_uri");
  });
  it("throws when Meta answers an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: "bad code", code: 100 } }), { status: 400 })),
    );
    await expect(
      exchangeEmbeddedSignupCode({ appId: "1", appSecret: "s", code: "c" }),
    ).rejects.toThrow();
  });
});