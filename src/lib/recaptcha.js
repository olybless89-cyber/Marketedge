/* Google reCAPTCHA v3 verification helper.
   Server-side only — the secret key must never leave the backend. */

export async function verifyRecaptcha(token, secretKey = process.env.RECAPTCHA_SECRET_KEY) {
  if (!token || typeof token !== 'string') {
    return { ok: false, error: 'reCAPTCHA token missing.' };
  }
  if (!secretKey) {
    return { ok: false, error: 'reCAPTCHA is not configured on the server.' };
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
