/* Google reCAPTCHA v3 verification helper.
   Server-side only — the secret key must never leave the backend.

   Graceful degradation: if RECAPTCHA_SECRET_KEY is not configured on the
   server, verification is SKIPPED (allowed) rather than hard-blocked. This
   mirrors the mail system's pattern (log-only mode when SMTP isn't set up):
   an unconfigured optional feature should never take down login, register,
   or contact-form submission for every user. A console.warn is emitted so
   this is visible in the server logs. Once real keys are set via
   RECAPTCHA_SITE_KEY / RECAPTCHA_SECRET_KEY, verification is enforced as
   normal. */

let warnedUnconfigured = false;

export async function verifyRecaptcha(token, secretKey = process.env.RECAPTCHA_SECRET_KEY) {
  if (!secretKey) {
    if (!warnedUnconfigured) {
      console.warn('[recaptcha] RECAPTCHA_SECRET_KEY is not set — skipping reCAPTCHA verification (allowing request). Set RECAPTCHA_SITE_KEY and RECAPTCHA_SECRET_KEY to enable bot protection.');
      warnedUnconfigured = true;
    }
    return { ok: true, skipped: true, reason: 'not-configured' };
  }

  if (!token || typeof token !== 'string') {
    return { ok: false, error: 'reCAPTCHA token missing.' };
  }

  // Allow test runs to bypass the live Google check without exposing this in production.
  if (process.env.NODE_ENV === 'test' && secretKey === 'test-secret-key') {
    return { ok: true, score: 1.0 };
  }

  try {
    const response = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: secretKey, response: token }),
    });

    if (!response.ok) {
      return { ok: false, error: 'reCAPTCHA verification request failed. Please try again.' };
    }

    const data = await response.json();
    if (data.success === true) {
      return { ok: true, score: data.score ?? null };
    }

    return {
      ok: false,
      error: 'reCAPTCHA check failed. Please reload the page and try again.',
      codes: data['error-codes'] || [],
    };
  } catch (err) {
    return { ok: false, error: 'Could not reach reCAPTCHA. Please try again later.' };
  }
}
