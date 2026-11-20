export type Section = "swarm" | "world" | "evidence" | "cases" | "defense"

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
}

export type WatchStatus = {
  kill_switch: boolean
  halted_reason: string
  reader: "ready" | "unavailable"
  evidence_count: number
  case_count: number
  canaries: string[]
  alerts: number
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

export type LatLon = { lat: number; lon: number }

export type Place = {
  host: string
  ip: string
  ips: string[]
  lat: number | null
  lon: number | null
  city: string
  country: string
  country_code: string
  asn: number | null
  org: string
  status: "located" | "no-location" | "unresolved" | "private"
  resolved_at: string
}

export type WorldHost = {
  host: string
  threat: number
  dominant: ThreatKind | "unknown"
  kinds: Partial<Record<ThreatKind, number>>
  evidence: string[]
  senders: string[]
  platforms: string[]
  feeds: string[]
  listings: FeedListing[]
  place: Place | null
}

export type FeedListing = {
  source: string
  url: string
  listed: string
  reference: string
  tags: string[]
}

export type Feed = {
  id: string
  name: string
  kind: ThreatKind
  about: string
  home: string
  license: string
  fetched_at: string | null
  count: number
  error: string
}

export type Intel = { feeds: Feed[]; total: number }

export type WorldAgent = {
  name: string
  threat: number
  dominant: ThreatKind | "unknown"
  kinds: Partial<Record<ThreatKind, number>>
  evidence: string[]
  platforms: string[]
  hosts: string[]
  position: LatLon | null
  pinned_to: string | null
}

export type WorldArc = {
  agent: string
  host: string
  kind: ThreatKind
  threat: number
  from: LatLon
  to: LatLon
}

export type World = {
  generated_at: string
  database: { status: "ready" | "downloading" | "missing" | "failed" | "off"; note: string; attribution: string }
  hosts: WorldHost[]
  agents: WorldAgent[]
  unplaced: WorldAgent[]
  arcs: WorldArc[]
  countries: { code: string; name: string; hosts: number; threat: number; agents: number }[]
  pending: number
  intel: Intel
}

export type Severity = "info" | "low" | "medium" | "high" | "critical"

export type DefenseEvent = {
  id: string
  at: string
  last_at: string
  kind: string
  severity: Severity
  source: "network" | "agent"
  ip: string
  country: string
  country_code: string
  org: string
  method: string
  path: string
  user_agent: string
  detail: string
  count: number
}

export type SafetyCheck = { name: string; state: "ok" | "warn" | "fail"; detail: string }

export type DefenseReport = {
  events: DefenseEvent[]
  last_day: { by_kind: Record<string, number>; hostile_ips: number; serious: number }
  locked: { ip: string; until: string }[]
  checks: SafetyCheck[]
}
