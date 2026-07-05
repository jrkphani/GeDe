import { useState, type ReactNode } from 'react'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from './command'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { Swatch } from './swatch'

// Issue 010 — the one type-ahead parameter picker, shared by the register
// grid's combobox cell (EditableGrid) and the canvas composer's per-dimension
// pickers, so the "same picker logic" requirement is met by sharing, not
// forking. Owns the Popover + cmdk Command list (filter input, empty state,
// clear item, colored options); the caller owns the trigger element and what
// a selection means (bind, unbind, move focus).
export interface ComboboxOption {
  value: string
  label: string
  color?: string
}

export interface ComboboxProps {
  value: string | null
  options: ComboboxOption[]
  onChange: (value: string | null) => void
  // The trigger element (a button), passed through Radix's `asChild` so the
  // caller keeps full control of its ref, class and keyboard grammar.
  trigger: ReactNode
  // Controlled open state is optional — the grid cell drives it to keep its
  // editing/nav state in sync; the composer lets the primitive own it.
  open?: boolean
  onOpenChange?: (open: boolean) => void
  filterPlaceholder?: string
  clearLabel?: string
  contentClassName?: string
  align?: 'start' | 'center' | 'end'
}

export function Combobox({
  value,
  options,
  onChange,
  trigger,
  open: openProp,
  onOpenChange,
  filterPlaceholder = 'Type to filter…',
  clearLabel = '— clear —',
  contentClassName = 'combobox-popover',
  align = 'start',
}: ComboboxProps) {
  const [openState, setOpenState] = useState(false)
  const open = openProp ?? openState

  function setOpen(next: boolean) {
    if (openProp === undefined) setOpenState(next)
    onOpenChange?.(next)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className={contentClassName} align={align} sideOffset={2}>
        <Command loop>
          <CommandInput autoFocus placeholder={filterPlaceholder} />
          <CommandList>
            <CommandEmpty>No match</CommandEmpty>
            {value !== null && (
              <CommandItem
                value="__clear__"
                onSelect={() => {
                  onChange(null)
                  setOpen(false)
                }}
              >
                <span className="grid-cell__placeholder">{clearLabel}</span>
              </CommandItem>
            )}
            {options.map((opt) => (
              <CommandItem
                key={opt.value}
                value={opt.label}
                onSelect={() => {
                  onChange(opt.value)
                  setOpen(false)
                }}
              >
                <Swatch color={opt.color} />
                {opt.label}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
