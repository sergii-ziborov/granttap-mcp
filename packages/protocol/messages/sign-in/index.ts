import { z } from "zod";

/**
 * A browser sign-in a service asked for, done on the phone.
 *
 * `signin.request` goes from the computer to the phone with the page to open.
 * `signin.result` comes back with what the person did and, when the service
 * redirected the browser to a loopback address, the path and query of that
 * redirect, which the computer delivers to the command waiting for it. The
 * redirect is the only thing that travels: no page, cookie or header does.
 */
export const SIGN_IN_URL_MAX = 8_192;
export const SIGN_IN_CALLBACK_MAX = 4_096;

const SignInId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
/** Printable ASCII without a space: nothing here can end a request line or start a header. */
const PATH = /^\/[\x21-\x22\x24-\x3e\x40-\x7e]*$/;
const QUERY = /^[\x21-\x22\x24-\x7e]*$/;

export function isSignInUrl(value: string): boolean {
  if (value.length > SIGN_IN_URL_MAX) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0 && !url.username && !url.password;
  } catch {
    return false;
  }
}

export const SignInRequest = z.object({
  type: z.literal("signin.request"),
  id: SignInId,
  /** The chat that asked; absent when the call could not be attributed to one. */
  sessionId: z.string().trim().min(1).max(256).optional(),
  url: z.string().max(SIGN_IN_URL_MAX).refine(isSignInUrl, "sign-in pages are https"),
  service: z.string().trim().min(1).max(80),
  reason: z.string().trim().min(1).max(300).optional(),
  /** The loopback port a command on the computer listens on for the redirect. */
  callbackPort: z.number().int().min(1).max(65_535).optional(),
  createdAt: z.number().finite(),
  expiresAt: z.number().finite(),
}).refine((request) => request.expiresAt > request.createdAt, { path: ["expiresAt"] });
export type SignInRequest = z.infer<typeof SignInRequest>;

/** Where the browser was redirected on the loopback address: a path and a query, no host. */
export const SignInCallback = z.object({
  path: z.string().min(1).max(SIGN_IN_CALLBACK_MAX).regex(PATH),
  query: z.string().max(SIGN_IN_CALLBACK_MAX).regex(QUERY).optional(),
}).refine((callback) => callback.path.length + (callback.query?.length ?? 0) < SIGN_IN_CALLBACK_MAX);
export type SignInCallback = z.infer<typeof SignInCallback>;

export const SignInResult = z.object({
  type: z.literal("signin.result"),
  id: SignInId,
  sessionId: z.string().trim().min(1).max(256).optional(),
  outcome: z.enum(["completed", "cancelled"]),
  callback: SignInCallback.optional(),
  createdAt: z.number().finite(),
});
export type SignInResult = z.infer<typeof SignInResult>;
