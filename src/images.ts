/**
 * Images the user gives yxu: a screenshot pasted from the clipboard, an image file dragged into
 * the terminal (which types its path), or a path named in the message. The orchestrator sees
 * them (they go to Claude with the message); subagents get their paths, which agents with an
 * image-capable model can open.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { isWindows, resolveArgv, runSync, which } from "./platform.ts";

export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface Attachment {
  path: string;
  name: string;
  type: ImageType;
  bytes: number;
}

/** What Claude accepts per image. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const EXT = /\.(png|jpe?g|gif|webp)$/i;

/** The image type from the file's first bytes (not its name). */
export function sniff(buf: Uint8Array): ImageType | undefined {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  return undefined;
}

/** Check a file and describe it as an attachment; a readable error if it can't be one. */
export function attach(path: string): Attachment {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`no image at ${path}`);
  const bytes = statSync(path).size;
  if (bytes > MAX_IMAGE_BYTES) throw new Error(`${basename(path)} is ${(bytes / 1024 / 1024).toFixed(1)} MB; images can be at most 5 MB (resize or crop it)`);
  const type = sniff(readFileSync(path).subarray(0, 12));
  if (!type) throw new Error(`${basename(path)} is not a PNG, JPEG, GIF or WebP image`);
  return { path: resolve(path), name: basename(path), type, bytes };
}

export const imagesDir = (root: string) => join(root, ".yxu", "images");

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

/**
 * Image paths in a message: absolute, ~/, ./ or file:// paths ending in an image extension that
 * exist; quoted ('…', "…") or with backslash-escaped spaces, as terminals type dropped files.
 */
export function findImagePaths(text: string, cwd: string): { raw: string; path: string }[] {
  const out: { raw: string; path: string }[] = [];
  // A quoted path must start like one, so an apostrophe ("don't") never opens a quote.
  const start = String.raw`(?:file:\/\/)?(?:~|\.{1,2}|[A-Za-z]:)?[\\/]`;
  const re = new RegExp(String.raw`'(${start}[^'\n]*)'|"(${start}[^"\n]*)"|(${start}(?:\\ |[^\s'"])+)`, "g");
  for (const m of text.matchAll(re)) {
    let p = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (p.startsWith("file://")) {
      try {
        p = fileURLToPath(p); // file:///C:/a%20b.png on Windows, file:///tmp/a%20b.png elsewhere
      } catch {
        continue;
      }
    }
    p = p.replace(/\\ /g, " ");
    if (!EXT.test(p)) continue;
    if (p.startsWith("~")) p = join(homedir(), p.slice(1));
    const abs = isAbsolute(p) ? p : resolve(cwd, p);
    if (existsSync(abs) && !out.some((o) => o.path === abs)) out.push({ raw: m[0], path: abs });
  }
  return out;
}

/** The image on the system clipboard, saved under .yxu/images; or why there is none. */
export function clipboardImage(root: string): { path: string } | { error: string } {
  const file = join(imagesDir(root), `pasted-${stamp()}.png`);
  mkdirSync(imagesDir(root), { recursive: true });
  const save = (bytes: Uint8Array) => (bytes.length && sniff(bytes) ? (writeFileSync(file, bytes), { path: file }) : undefined);
  const run = (argv: string[]) => {
    // Resolved with the current PATH (Bun would use the one it started with).
    const p = Bun.spawnSync(resolveArgv([which(argv[0]!) ?? argv[0]!, ...argv.slice(1)]), { stdout: "pipe", stderr: "pipe", env: process.env });
    return { ok: p.exitCode === 0, out: p.stdout as Uint8Array };
  };
  if (process.platform === "darwin") {
    if (which("pngpaste") && run(["pngpaste", file]).ok && existsSync(file)) return { path: file };
    const r = runSync(["osascript", "-e", `set f to open for access POSIX file "${file}" with write permission`, "-e", "write (the clipboard as «class PNGf») to f", "-e", "close access f"]);
    if (r.code === 0 && existsSync(file) && statSync(file).size) return { path: file };
    return { error: "the clipboard has no image" };
  }
  if (isWindows) {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; $i=[Windows.Forms.Clipboard]::GetImage(); if ($i) { $i.Save('${file}', [Drawing.Imaging.ImageFormat]::Png) } else { exit 1 }`;
    const r = runSync(["powershell", "-NoProfile", "-STA", "-Command", ps]);
    return r.code === 0 && existsSync(file) ? { path: file } : { error: "the clipboard has no image" };
  }
  if (process.env.WAYLAND_DISPLAY && which("wl-paste")) {
    const types = new TextDecoder().decode(run(["wl-paste", "--list-types"]).out);
    const t = ["image/png", "image/jpeg", "image/webp", "image/gif"].find((x) => types.includes(x));
    if (!t) return { error: "the clipboard has no image" };
    return save(run(["wl-paste", "--no-newline", "--type", t]).out) ?? { error: "couldn't read the image from the clipboard" };
  }
  if (which("xclip")) {
    const types = new TextDecoder().decode(run(["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"]).out);
    const t = ["image/png", "image/jpeg", "image/webp", "image/gif"].find((x) => types.includes(x));
    if (!t) return { error: "the clipboard has no image" };
    return save(run(["xclip", "-selection", "clipboard", "-t", t, "-o"]).out) ?? { error: "couldn't read the image from the clipboard" };
  }
  return { error: "pasting images needs wl-paste (Wayland: wl-clipboard) or xclip (X11)" };
}

/** A note for the orchestrator: which images came with the message, and where agents can open them. */
export function imagesNote(images: Attachment[]): string {
  if (!images.length) return "";
  return `\n\n[yxu] The user attached ${images.length} image${images.length === 1 ? "" : "s"} (you can see ${images.length === 1 ? "it" : "them"} above): ${images.map((i) => i.path).join(", ")}. Subagents can't see your conversation: describe in their task what they need from an image, and give its path so agents whose model reads images can open it.`;
}

/** The user's message with its images, as the Agent SDK takes it. */
export async function* withImages(text: string, images: Attachment[]): AsyncGenerator<SDKUserMessage> {
  yield {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        ...images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.type, data: readFileSync(i.path).toString("base64") } })),
        { type: "text" as const, text: `${text}${imagesNote(images)}` },
      ],
    },
  } as SDKUserMessage;
}

/** "120 KB", "1.4 MB". */
export const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
