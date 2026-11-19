export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export const SIGNED_OUT = "milker:signed-out"

const UNREACHABLE = "Can't reach the server right now. The connection may have dropped; try again in a few seconds."
const gatewayStatus = new Set([502, 503, 504, 520, 521, 522, 523, 524, 530])

function send(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  })
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const retryable = !init?.method || init.method === "GET"
  let response: Response
  try {
    response = await send(path, init)
    if (retryable && gatewayStatus.has(response.status)) {
      await new Promise((resolve) => window.setTimeout(resolve, 1500))
      response = await send(path, init)
    }
  } catch {
    throw new ApiError(UNREACHABLE, 0)
  }
  const text = await response.text()
  let data: { error?: string } = {}
  if (text) {
    try {
      data = JSON.parse(text) as { error?: string }
    } catch {
      throw new ApiError(gatewayStatus.has(response.status) || !response.ok ? UNREACHABLE : "The server sent an unexpected reply.", response.status)
    }
  }
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
