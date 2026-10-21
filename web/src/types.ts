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

export type Section = "watch" | "speak" | "run" | "log"
