// HTML menus and dialogs laid over the game.
import QRCode from "qrcode"

export interface MenuItem {
  label: string
  key?: string
  action: () => void
  small?: boolean
  keyboardOnly?: boolean
}
export interface PanelButton {
  label: string
  action: () => void
  primary?: boolean
}
export interface PanelOptions {
  title: string
  text?: string
  url?: string
  buttons: PanelButton[]
}

const menu = document.getElementById("menu")!
const panel = document.getElementById("panel")!

function button(label: string, action: () => void, className = "") {
  const element = document.createElement("button")
  element.textContent = label
  if (className) element.className = className
  element.addEventListener("click", action)
  return element
}

// Called every frame; only rebuilds the buttons when they actually change.
let menuSignature = ""
export function setMenu(items: MenuItem[] | null) {
  menu.hidden = !items || !panel.hidden
  const signature = items
    ? items.map((item) => item.label + item.key).join("|")
    : ""
  if (!items || signature === menuSignature) return
  menuSignature = signature
  menu.replaceChildren(
    ...items.map((item) => {
      const element = button(
        "",
        item.action,
        [item.small && "small", item.keyboardOnly && "keyboard-only"]
          .filter(Boolean)
          .join(" "),
      )
      if (item.key) {
        const keyHint = document.createElement("span")
        keyHint.className = "key"
        keyHint.textContent = item.key + " "
        element.append(keyHint)
      }
      element.append(item.label)
      return element
    }),
  )
}

// A full-screen dialog; replaces any dialog already showing.
export function showPanel(options: PanelOptions) {
  const card = document.createElement("div")
  card.className = "card"
  const heading = document.createElement("h2")
  heading.textContent = options.title
  card.append(heading)
  if (options.text) {
    const paragraph = document.createElement("p")
    paragraph.textContent = options.text
    card.append(paragraph)
  }
  if (options.url) card.append(invite(options.url))
  const row = document.createElement("div")
  row.className = "buttons"
  row.append(
    ...options.buttons.map((spec) =>
      button(spec.label, spec.action, spec.primary ? "primary" : ""),
    ),
  )
  card.append(row)
  panel.replaceChildren(card)
  panel.hidden = false
  menu.hidden = true
}

export function hidePanel() {
  panel.hidden = true
}

// QR code plus the link itself, with Share (phones) and Copy buttons.
function invite(url: string) {
  const box = document.createElement("div")
  box.className = "invite"
  const qr = document.createElement("canvas")
  QRCode.toCanvas(qr, url, {
    margin: 2,
    width: 200,
    color: { dark: "#111111", light: "#ffffff" },
  })
    .then(() => qr.removeAttribute("style")) // the library sets an inline size; let the CSS size it
    .catch(() => qr.remove())
  const side = document.createElement("div")
  const link = document.createElement("input")
  link.readOnly = true
  link.value = url
  link.className = "link"
  link.addEventListener("focus", () => link.select())
  const buttons = document.createElement("div")
  buttons.className = "buttons"
  const shareData = {
    title: "Biplanes",
    text: "Come and dogfight me in Biplanes!",
    url,
  }
  if (navigator.share && navigator.canShare?.(shareData) !== false) {
    buttons.append(
      button(
        "SHARE…",
        () => {
          navigator.share(shareData).catch(() => {})
        },
        "primary",
      ),
    )
  }
  const copy = button("COPY LINK", async () => {
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      link.focus()
      link.select()
      document.execCommand("copy")
    } // clipboard API needs HTTPS
    copy.textContent = "COPIED!"
    setTimeout(() => {
      copy.textContent = "COPY LINK"
    }, 1500)
  })
  buttons.append(copy)
  side.append(link, buttons)
  box.append(qr, side)
  return box
}
