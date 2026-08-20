/**
 * Q-C1 - anonymous publishing with a secret management token.
 *
 * The token is the only proof of ownership a published sketch has. It is
 * generated server-side, returned once, and kept here in `localStorage` so the
 * creator can delete their own work from the device they made it on.
 *
 * Stored per sketch rather than as one blob so a corrupt entry cannot take the
 * whole set with it, and never sent anywhere except the delete endpoint.
 */

const PREFIX = 'rhythmisoze:manage:';

export function rememberManageToken(sketchId: string, token: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`${PREFIX}${sketchId}`, token);
  } catch {
    // Private browsing or a full store. The publish still succeeded; the user
    // simply cannot delete from this device, which the UI copy already warns
    // about. Failing the publish over it would be worse.
  }
}

export function getManageToken(sketchId: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(`${PREFIX}${sketchId}`);
  } catch {
    return null;
  }
}

export function forgetManageToken(sketchId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(`${PREFIX}${sketchId}`);
  } catch {
    // Nothing to recover from.
  }
}
