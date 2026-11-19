export type ChurchStatus = {
  congregation_size: number
  canon_size: number
  blessed_count: number
  prophets_filled: number
  prophets_remaining: number
  prophet_seats_open: boolean
}

export type ChurchBundle = {
  fetched_at: string
  status: ChurchStatus | null
  devotion: {
    date: string
    verse: { text: string; author: string; citation: string }
    tenet_of_the_day: { number: number; name: string }
    blessing?: string
  } | null
  tenets: {
    tenets: { number: number; name: string; teaching: string }[]
  } | null
  vigil: {
    vigils: Vigil[]
  } | null
  canon: {
    the_great_book: {
      prophet_name: string
      scripture_type: string
      content: string
      canonized_at: string
    }[]
  } | null
  errors: string[]
}

export type Vigil = {
  id: string
  title: string
  present: string[]
  human_candles: number
  lit: boolean
  current_call: { id: number; text: string } | null
  responses: { id: number; name: string; text: string; at: string }[]
}

export type SettingsView = {
  agent_name: string
  description: string
  has_key: boolean
  key_hint: string
  giving_url: string
  joining_words: string
  scripture_sent_today: number
  scripture_daily_cap: number
}

export type Finding = {
  id: string
  created_at: string
  updated_at: string
  kind: string
  title: string
  body: string
  sent: boolean
  voices: string[]
}

export type MemberProfile = {
  member: {
    name: string
    description: string
    is_prophet: boolean
    prophet_number: number | null
    joined_at: string
  }
  prophecies: { scripture_type: string; content: string; status: string }[]
}

export type Section = "swarm" | "evidence" | "cases" | "church" | "speak" | "run" | "log"

export type ThreatKind =
  | "injection"
  | "installer"
  | "wallet"
  | "phishing"
  | "impersonation"
  | "benign"
  | "other"

export type Reading = {
  kind: ThreatKind
  summary: string
  confidence: number
  indicators: {
    urls: string[]
    addresses: string[]
    handles: string[]
    commands: string[]
  }
}

export type EvidenceItem = {
  id: string
  received_at: string
  captured_at: string
  platform: string
  channel: string
  url: string
  sender: string
  sha256: string
  reading: Reading
  kind: ThreatKind
  overridden: boolean
  cases: string[]
  sample: boolean
}

export type WatchStatus = {
  kill_switch: boolean
  halted_reason: string
  reader: "ready" | "unavailable"
  evidence_count: number
  case_count: number
  canaries: string[]
}

export type SwarmNode = {
  id: string
  label: string
  type: "agent" | "address" | "domain" | "self"
  threat: number
  dominant: ThreatKind | "self" | "unknown"
  kinds: Partial<Record<ThreatKind, number>>
  evidence: string[]
  platforms: string[]
  sent: number
}

export type SwarmLink = {
  source: string
  target: string
  kind: "reached us" | "mentions" | "promotes" | "links to" | "installs from"
  weight: number
  evidence: string[]
}

export type SwarmGraph = {
  sample: boolean
  generated_at: string
  nodes: SwarmNode[]
  links: SwarmLink[]
  items: EvidenceItem[]
}

export type CaseFile = {
  id: string
  created_at: string
  updated_at: string
  title: string
  summary: string
  items: string[]
  submissions: { at: string; channel: string; reference: string }[]
}
