export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export const SIGNED_OUT = "profit:signed-out"

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  })
  const text = await response.text()
  const data = text ? (JSON.parse(text) as { error?: string }) : {}
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event(SIGNED_OUT))
    throw new ApiError(data.error || response.statusText, response.status)
  }
  return data as T
}

export function decodeText(value: string): string {
  return value
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
}

export function cleanName(name: string): string {
  return name.replace(/^\*+\s*/, "").replace(/\s*\*+$/, "").trim()
}

export function when(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}
