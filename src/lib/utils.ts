import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn/ui class merge helper: clsx for conditionals, tailwind-merge to dedupe. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
