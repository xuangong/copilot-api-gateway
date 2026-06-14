/**
 * Resend email transport — Week 5b port of src/lib/email.ts.
 *
 * Module-level state so the gateway entry can `initResend(env.RESEND_API_KEY)`
 * once at boot. Tests inject via setEmailSenderForTest to avoid live HTTP.
 */
import { RESEND_FROM_EMAIL } from '../config/constants.ts'

let resendApiKey: string | null = null

export interface EmailSender {
  sendVerificationCode(to: string, code: string): Promise<boolean>
  sendMagicLink(to: string, link: string): Promise<boolean>
}

let overrideSender: EmailSender | null = null

export function initResend(key: string) {
  resendApiKey = key
}

export function setEmailSenderForTest(sender: EmailSender | null) {
  overrideSender = sender
}

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  if (!resendApiKey) return false
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: RESEND_FROM_EMAIL, to: [to], subject, html }),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function sendVerificationCode(to: string, code: string): Promise<boolean> {
  if (overrideSender) return overrideSender.sendVerificationCode(to, code)
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
      <h2 style="color: #1a1a1a; margin-bottom: 8px;">Verification Code</h2>
      <p style="color: #666; margin-bottom: 24px;">Enter this code to complete your registration:</p>
      <div style="background: #f4f4f5; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 24px;">
        <span style="font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #1a1a1a;">${code}</span>
      </div>
      <p style="color: #999; font-size: 13px;">This code expires in 10 minutes. If you didn't request this, ignore this email.</p>
    </div>
  `
  return sendEmail(to, `${code} is your verification code`, html)
}

export async function sendMagicLink(to: string, link: string): Promise<boolean> {
  if (overrideSender) return overrideSender.sendMagicLink(to, link)
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
      <h2 style="color: #1a1a1a; margin-bottom: 8px;">Sign in</h2>
      <p style="color: #666; margin-bottom: 24px;">Click the button below to sign in to your account:</p>
      <a href="${link}" style="display: inline-block; background: #7c3aed; color: #fff; text-decoration: none; padding: 12px 32px; border-radius: 8px; font-weight: 600; font-size: 15px;">Sign In</a>
      <p style="color: #999; font-size: 13px; margin-top: 24px;">This link expires in 10 minutes. If you didn't request this, ignore this email.</p>
      <p style="color: #bbb; font-size: 12px; margin-top: 16px; word-break: break-all;">Or copy this link: ${link}</p>
    </div>
  `
  return sendEmail(to, 'Sign in to Copilot Gateway', html)
}
