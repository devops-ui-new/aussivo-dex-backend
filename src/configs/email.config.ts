import dns from 'dns';
import nodemailer from 'nodemailer';
import { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM, EMAIL_FROM_NAME } from './constants';
import logger from './logger.config';
import fs from 'fs';
import path from 'path';
import Handlebars from 'handlebars';

/** Railway / some clouds break IPv6 routes to SMTP; prefer A record when timeouts occur. */
const ipv4First =
  process.env.SMTP_IPV4_FIRST === '1' || process.env.SMTP_IPV4_FIRST === 'true';
if (ipv4First) {
  dns.setDefaultResultOrder('ipv4first');
}

const isSmtpConfigured = !!(SMTP_USER && SMTP_PASS && SMTP_HOST);

const smtpTransportOptions = {
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  requireTLS: SMTP_PORT === 587,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
  connectionTimeout: 90_000,
  greetingTimeout: 45_000,
  socketTimeout: 120_000,
  tls: {
    minVersion: 'TLSv1.2' as const,
  },
};

const transporter = isSmtpConfigured ? nodemailer.createTransport(smtpTransportOptions) : null;

if (isSmtpConfigured) {
  logger.info(`[EMAIL] SMTP configured: ${SMTP_HOST}:${SMTP_PORT} as ${SMTP_USER}`);
  const hostLower = (SMTP_HOST || '').toLowerCase();
  if (hostLower.includes('gmail') && EMAIL_FROM && SMTP_USER) {
    if (EMAIL_FROM.toLowerCase() !== SMTP_USER.toLowerCase()) {
      logger.warn(
        `[EMAIL] EMAIL_FROM (${EMAIL_FROM}) differs from SMTP_USER (${SMTP_USER}). Gmail often rejects or drops mail unless "Send mail as" is enabled for that address in Google Account settings.`,
      );
    }
  }
  if (hostLower.includes('brevo') && EMAIL_FROM) {
    logger.info(
      `[EMAIL] Brevo: ensure "${EMAIL_FROM}" is added & verified under Senders, Domains (and use the SMTP key from Brevo as SMTP_PASS, not your account password).`,
    );
    if (SMTP_PORT === 587) {
      logger.info(
        `[EMAIL] If you see "Connection timeout" from Railway, set SMTP_PORT=465 (SSL) or SMTP_IPV4_FIRST=true — cloud egress often fails on 587 STARTTLS.`,
      );
    }
  }
  if (ipv4First) logger.info('[EMAIL] SMTP_IPV4_FIRST enabled (IPv4-first DNS for SMTP host)');
} else {
  logger.warn('[EMAIL] SMTP not configured — emails will be skipped. Set SMTP_USER and SMTP_PASS in .env');
}

export const sendEmail = async (to: string, subject: string, templateName: string, data: Record<string, any>) => {
  if (!transporter) {
    logger.warn(`[EMAIL] Skipped (no SMTP): ${subject} → ${to}`);
    return false;
  }
  try {
    // Resolve template path — works in both ts-node (src/) and compiled (build/) mode
    let templatePath = path.join(__dirname, '..', 'template', `${templateName}.html`);
    if (!fs.existsSync(templatePath)) {
      // Try alternate paths
      templatePath = path.join(process.cwd(), 'src', 'template', `${templateName}.html`);
    }

    let htmlContent: string;
    if (fs.existsSync(templatePath)) {
      const html = fs.readFileSync(templatePath, 'utf-8');
      const template = Handlebars.compile(html);
      htmlContent = template(data);
    } else {
      logger.warn(`[EMAIL] Template not found: ${templateName}, sending plain text`);
      htmlContent = `<p>${JSON.stringify(data)}</p>`;
    }

    const info = await transporter.sendMail({
      from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
      to,
      subject,
      html: htmlContent,
    });

    logger.info(`[EMAIL] ✅ Sent to ${to}: ${subject} (messageId: ${info.messageId})`);
    return true;
  } catch (err: any) {
    logger.error(`[EMAIL] ❌ Failed to ${to}: ${err.message}`);
    if (err.code) logger.error(`[EMAIL] SMTP code: ${err.code}`);
    if (err.responseCode != null)
      logger.error(`[EMAIL] SMTP ${err.responseCode}: ${(err.response || '').toString().trim()}`);
    logger.error(`[EMAIL] Details: host=${SMTP_HOST} port=${SMTP_PORT} user=${SMTP_USER} from=${EMAIL_FROM}`);
    return false;
  }
};
