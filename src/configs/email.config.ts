import nodemailer from 'nodemailer';
import { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM, EMAIL_FROM_NAME } from './constants';
import logger from './logger.config';
import fs from 'fs';
import path from 'path';
import Handlebars from 'handlebars';

const isSmtpConfigured = !!(SMTP_USER && SMTP_PASS && SMTP_HOST);

const transporter = isSmtpConfigured ? nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
}) : null;

if (isSmtpConfigured) {
  logger.info(`[EMAIL] SMTP configured: ${SMTP_HOST}:${SMTP_PORT} as ${SMTP_USER}`);
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
    logger.error(`[EMAIL] Details: host=${SMTP_HOST} port=${SMTP_PORT} user=${SMTP_USER}`);
    return false;
  }
};
