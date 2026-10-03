// Couch play: a TV (Chromecast or any big-screen browser) runs the game and
// phones connect to it directly as controllers.
import { GuestMsg } from "./net"

export const CAST_APP_ID = "743316D5"
export const CAST_NAMESPACE = "urn:x-cast:io.github.ianparkinson.biplanes"

// TV -> phone
export type TvMsg =
  | {
      t: "pad"
      n: number
      slot: number
      mode: "title" | "playing" | "over"
      paused: boolean
      deaths: number[]
      players: boolean[]
    } // players[i]: a phone is flying plane i (else the CPU)
  | { t: "full" }
// phone -> TV: the same input / start messages an online guest sends
export type PadMsg = GuestMsg

// Sent as connection metadata so a phone that reconnects gets its plane back.
export interface PadHello {
  kind: "pad"
  id: string
}

// Messages between the Cast sender (phone) and the receiver (TV) over the Cast channel.
export type CastMsg = { t: "hello" } | { t: "code"; code: string }
