/**
 * @gede/mail — every email GeDe sends, branded from the design tokens and rendered in the
 * recipient's locale. Framework-free and dependency-free: the same module runs in the
 * sync service (share mail through SES) and in the Cognito custom-message Lambda
 * (one-time codes), and nothing here touches the DOM, Node modules or the network.
 */
export { escapeHtml } from './escape.js';
export { palette, type ColorScheme, type Palette } from './generated/palette.js';
export {
  CATALOGUE,
  DEFAULT_MAIL_LOCALE,
  format,
  isMailLocale,
  MAIL_LOCALES,
  MESSAGE_KEYS,
  resolveMailLocale,
  SUBJECT_MAX,
  subjectFor,
  translate,
  truncate,
  type MailLocale,
  type MessageKey,
  type MessageParams,
  type Messages,
} from './i18n.js';
export {
  CODE_MAIL_KINDS,
  MAIL_KINDS,
  renderCodeMail,
  renderShareMail,
  SHARE_MAIL_KINDS,
  type CodeMailInput,
  type CodeMailKind,
  type MailKind,
  type RenderedMail,
  type ShareMailInput,
  type ShareMailKind,
} from './kinds.js';
export {
  BRAND_MARK_SIZE,
  BRAND_MARK_URL,
  COLUMN_WIDTH,
  renderHtml,
  renderText,
  type MailAction,
  type MailContent,
} from './layout.js';
