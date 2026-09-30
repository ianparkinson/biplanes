// HTML menus and dialogs laid over the game.
import QRCode from "qrcode";

export interface MenuItem { label: string; key?: string; action: () => void; small?: boolean; keyboardOnly?: boolean }
export interface PanelButton { label: string; action: () => void; primary?: boolean }
export interface PanelOptions { title: string; text?: string; url?: string; buttons: PanelButton[] }

const menu = document.getElementById("menu")!;
const panel = document.getElementById("panel")!;

function button(label: string, action: () => void, cls = "") {
  const b = document.createElement("button");
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener("click", action);
  return b;
}

// Called every frame; only rebuilds the buttons when they actually change.
let menuSignature = "";
export function setMenu(items: MenuItem[] | null) {
  menu.hidden = !items || !panel.hidden;
  const sig = items ? items.map(i => i.label + i.key).join("|") : "";
  if (!items || sig === menuSignature) return;
  menuSignature = sig;
  menu.replaceChildren(...items.map(i => {
    const b = button("", i.action, [i.small && "small", i.keyboardOnly && "keyboard-only"].filter(Boolean).join(" "));
    if (i.key) {
      const k = document.createElement("span");
      k.className = "key"; k.textContent = i.key + " ";
      b.append(k);
    }
    b.append(i.label);
    return b;
  }));
}

export function showPanel(o: PanelOptions) {
  const card = document.createElement("div");
  card.className = "card";
  const h = document.createElement("h2");
  h.textContent = o.title;
  card.append(h);
  if (o.text) {
    const p = document.createElement("p");
    p.textContent = o.text;
    card.append(p);
  }
  if (o.url) card.append(invite(o.url));
  const row = document.createElement("div");
  row.className = "buttons";
  row.append(...o.buttons.map(b => button(b.label, b.action, b.primary ? "primary" : "")));
  card.append(row);
  panel.replaceChildren(card);
  panel.hidden = false;
  menu.hidden = true;
}

export function hidePanel() { panel.hidden = true; }

// QR code plus the link itself, with Share (phones) and Copy buttons.
function invite(url: string) {
  const box = document.createElement("div");
  box.className = "invite";
  const qr = document.createElement("canvas");
  QRCode.toCanvas(qr, url, { margin: 2, width: 200, color: { dark: "#111111", light: "#ffffff" } })
    .then(() => qr.removeAttribute("style")) // the library sets an inline size; let the CSS size it
    .catch(() => qr.remove());
  const side = document.createElement("div");
  const link = document.createElement("input");
  link.readOnly = true; link.value = url; link.className = "link";
  link.addEventListener("focus", () => link.select());
  const buttons = document.createElement("div");
  buttons.className = "buttons";
  const shareData = { title: "Biplanes", text: "Come and dogfight me in Biplanes!", url };
  if (navigator.share && navigator.canShare?.(shareData) !== false) {
    buttons.append(button("SHARE…", () => { navigator.share(shareData).catch(() => {}); }, "primary"));
  }
  const copy = button("COPY LINK", async () => {
    try { await navigator.clipboard.writeText(url); }
    catch { link.focus(); link.select(); document.execCommand("copy"); } // clipboard API needs HTTPS
    copy.textContent = "COPIED!";
    setTimeout(() => { copy.textContent = "COPY LINK"; }, 1500);
  });
  buttons.append(copy);
  side.append(link, buttons);
  box.append(qr, side);
  return box;
}
