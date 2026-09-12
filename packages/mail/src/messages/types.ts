import { messages as enUS } from './en-US.js';

/** Every key the mail catalogue knows; en-US is the reference locale. */
export type MessageKey = keyof typeof enUS;

/** One locale's catalogue: exactly the reference keys, every value a non-empty string. */
export type Messages = Readonly<Record<MessageKey, string>>;

export const MESSAGE_KEYS: readonly MessageKey[] = Object.keys(enUS) as MessageKey[];
