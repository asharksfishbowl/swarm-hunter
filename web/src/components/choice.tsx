import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.tsx"

export type ChoiceOption = { value: string; label: string }

export function Choice({
  value,
  options,
  onChange,
  placeholder,
  label,
  className,
  size,
}: {
  value: string
  options: ChoiceOption[]
  onChange: (value: string) => void
  placeholder?: string
  label: string
  className?: string
  size?: "sm" | "default"
}) {
  return (
    <Select
      items={options}
      value={value || null}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next)
      }}
    >
      <SelectTrigger aria-label={label} className={className ?? "w-full"} size={size}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
