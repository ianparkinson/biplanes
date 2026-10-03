// Google Cast sender: launches the TV app on a Chromecast and asks it for the
// game's room code. Only Chrome (Android and desktop) can start a cast.
import { CAST_APP_ID, CAST_NAMESPACE, CastMsg } from "./couch"

declare const cast: any
declare const chrome: any
declare global {
  interface Window {
    __onGCastApiAvailable?: (available: boolean) => void
  }
}

let available: Promise<boolean> | null = null

export function loadCastSender(): Promise<boolean> {
  return (available ??= new Promise((resolve) => {
    // The SDK calls this global once it has loaded.
    window.__onGCastApiAvailable = (available) => {
      if (available) {
        cast.framework.CastContext.getInstance().setOptions({
          receiverApplicationId: CAST_APP_ID,
          autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
        })
      }
      resolve(available)
    }
    const script = document.createElement("script")
    script.src =
      "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1"
    script.onerror = () => resolve(false)
    document.head.append(script)
    setTimeout(() => resolve(false), 10000)
  }))
}

// Shows Chrome's device picker, starts the TV app and resolves with its room code.
export async function castToTv(): Promise<string> {
  const context = cast.framework.CastContext.getInstance()
  try {
    await context.requestSession()
  } catch (errorCode) {
    throw new Error(
      errorCode === "cancel"
        ? "cancelled"
        : `Couldn't start the game on the TV (${errorCode}).`,
    )
  }
  const session = context.getCurrentSession()
  if (!session) throw new Error("Couldn't start the game on the TV.")
  return new Promise((resolve, reject) => {
    const done = () => {
      clearInterval(poll)
      clearTimeout(timer)
      session.removeMessageListener(CAST_NAMESPACE, onMessage)
    }
    const onMessage = (_ns: string, data: string | CastMsg) => {
      const msg: CastMsg = typeof data === "string" ? JSON.parse(data) : data
      if (msg.type === "code") {
        done()
        resolve(msg.code)
      }
    }
    session.addMessageListener(CAST_NAMESPACE, onMessage)
    // The TV may still be loading or registering its room, so keep asking.
    const hello = () =>
      session
        .sendMessage(CAST_NAMESPACE, { type: "hello" } satisfies CastMsg)
        .catch(() => {})
    hello()
    const poll = setInterval(hello, 1000)
    const timer = setTimeout(() => {
      done()
      reject(new Error("The TV app started but didn't respond."))
    }, 30000)
  })
}
