import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { attach, clipboardImage, findImagePaths, sniff, withImages, type Attachment } from "../src/images.ts";
import type { RunOutcome } from "../src/orchestrator/run.ts";
import { runPipeline } from "../src/orchestrator/pipeline.ts";
import { App, type Engine } from "../src/tui/app.ts";
import { createTheme } from "../src/tui/theme.ts";
import type { Frame } from "../src/tui/view.ts";
import { fakeCli, pathWith, testCatalog } from "./helpers.ts";

// A real 1×1 PNG.
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");

let dir: string;
let bin: string;
const origPath = process.env.PATH;
const origWayland = process.env.WAYLAND_DISPLAY;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yxu-img-"));
  bin = mkdtempSync(join(tmpdir(), "yxu-img-bin-"));
  writeFileSync(join(dir, "shot one.png"), PNG);
  writeFileSync(join(dir, "notes.txt"), "not an image");
  writeFileSync(join(dir, "fake.png"), "not really a png");
});
afterEach(() => {
  process.env.PATH = origPath;
  if (origWayland === undefined) delete process.env.WAYLAND_DISPLAY;
  else process.env.WAYLAND_DISPLAY = origWayland;
  rmSync(dir, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

describe("images", () => {
  test("type comes from the bytes; size and type are checked", () => {
    expect(sniff(PNG)).toBe("image/png");
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniff(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(sniff(Buffer.from("RIFF0000WEBPVP8 "))).toBe("image/webp");
    expect(attach(join(dir, "shot one.png"))).toMatchObject({ name: "shot one.png", type: "image/png", bytes: PNG.length });
    expect(() => attach(join(dir, "fake.png"))).toThrow(/is not a PNG, JPEG, GIF or WebP image/);
    expect(() => attach(join(dir, "missing.png"))).toThrow(/no image at/);
    writeFileSync(join(dir, "big.png"), Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]));
    expect(() => attach(join(dir, "big.png"))).toThrow(/at most 5 MB/);
  });

  test("image paths in a message: quoted, escaped, file:// and relative, as terminals type dropped files", () => {
    const p = join(dir, "shot one.png");
    const found = (t: string) => findImagePaths(t, dir).map((f) => f.path);
    expect(found(`don't miss '${p}' please`)).toEqual([p]); // an apostrophe doesn't open a quote
    expect(found(`see "${p}"`)).toEqual([p]);
    expect(found(`see ${p.replace(/ /g, "\\ ")}`)).toEqual([p]);
    expect(found(`file://${encodeURI(p)}`)).toEqual([p]);
    expect(found("look at './shot one.png'")).toEqual([p]);
    expect(found(`${join(dir, "notes.txt")} and /nope/x.png`)).toEqual([]);
  });

  test("the clipboard's image, from wl-paste (Wayland) or xclip (X11)", () => {
    process.env.PATH = pathWith(bin, origPath);
    process.env.WAYLAND_DISPLAY = "wayland-test";
    writeFileSync(join(bin, "clip.png"), PNG);
    fakeCli(bin, "wl-paste", `#!/bin/sh\ncase "$*" in *--list-types*) printf 'text/plain\\nimage/png\\n';; *) cat "${bin}/clip.png";; esac\n`);
    const got = clipboardImage(dir);
    expect("path" in got && readFileSync(got.path).equals(PNG)).toBe(true);
    expect("path" in got && got.path.startsWith(join(dir, ".yxu", "images", "pasted-"))).toBe(true);
    fakeCli(bin, "wl-paste", `#!/bin/sh\nprintf 'text/plain\\n'\n`);
    expect(clipboardImage(dir)).toEqual({ error: "the clipboard has no image" });
    delete process.env.WAYLAND_DISPLAY;
    fakeCli(bin, "xclip", `#!/bin/sh\ncase "$*" in *TARGETS*) printf 'TARGETS\\nimage/png\\n';; *) cat "${bin}/clip.png";; esac\n`);
    expect("path" in clipboardImage(dir)).toBe(true);
  });

  test("the message for Claude: the images, then the text with where they are", async () => {
    const a = attach(join(dir, "shot one.png"));
    const msgs = [];
    for await (const m of withImages("Fix this layout", [a])) msgs.push(m);
    const content = (msgs[0]!.message as { content: { type: string; source?: { media_type: string; data: string }; text?: string }[] }).content;
    expect(content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } });
    expect(content[1]!.text).toStartWith("Fix this layout\n\n[yxu] The user attached 1 image");
    expect(content[1]!.text).toContain(a.path);
  });

  test("a pipeline's plan step sees the images; every step's goal names them", async () => {
    const a = attach(join(dir, "shot one.png"));
    const seen: { images?: Attachment[]; prompt: string }[] = [];
    await runPipeline({
      goal: "Match the mockup",
      cfg: parseConfig("agents:\n  coder: { cli: opencode }\nworkflows:\n  p:\n    mode: pipeline\n    steps:\n      - { id: plan, type: plan }\n", join(dir, "yxu.yaml")),
      workflow: { mode: "pipeline", name: "p", steps: [{ id: "plan", type: "plan", max_tasks: 2 }] },
      root: dir,
      render: { assistantText: () => {}, toolCall: () => {}, hooks: {} },
      abort: new AbortController(),
      images: [a],
      askImpl: async (o) => {
        seen.push({ images: (o as { images?: Attachment[] }).images, prompt: o.prompt });
        return { value: { summary: "s", tasks: [] }, costUsd: 0 } as never;
      },
    }).catch(() => undefined);
    expect(seen[0]!.images?.map((i) => i.name)).toEqual(["shot one.png"]);
    expect(seen[0]!.prompt).toContain(`(Images from the user, for agents that can open them: ${a.path})`);
  });
});

describe("images in the interface", () => {
  test("ctrl+v and /image attach; the message carries them; a named file is attached and replaced", async () => {
    process.env.PATH = pathWith(bin, origPath);
    process.env.WAYLAND_DISPLAY = "wayland-test";
    writeFileSync(join(bin, "clip.png"), PNG);
    fakeCli(bin, "wl-paste", `#!/bin/sh\ncase "$*" in *--list-types*) printf 'image/png\\n';; *) cat "${bin}/clip.png";; esac\n`);
    const runs: { goal: string; images?: string[] }[] = [];
    const engine: Engine = {
      async run({ goal, images, session }) {
        runs.push({ goal, images: images?.map((i) => i.name) });
        return { runId: "r", ok: true, finalText: "ok", costUsd: 0, session } as RunOutcome;
      },
    };
    let frame: Frame = { rows: [] };
    const app = new App({ cfg: parseConfig("agents:\n  coder: { cli: opencode }\ncontext: { repo_map: false }\n", join(dir, "yxu.yaml")), root: dir, theme: createTheme({ depth: "none", ascii: false, reducedMotion: true }), engine, historyFile: null, catalog: testCatalog(), draw: (f) => (frame = f), size: () => ({ width: 130, height: 40 }), exit: () => {} });
    const screen = () => (app.render(), frame.rows.join("\n"));

    app.input("\x16"); // ctrl+v
    expect(app.store.state.attachments?.map((a) => a.name)).toEqual([expect.stringMatching(/^pasted-.*\.png$/)]);
    app.input("/image ./shot one.png\r");
    expect(app.store.state.attachments).toHaveLength(2);
    expect(screen()).toContain("/image clear removes");
    app.input("\r"); // nothing typed
    expect(app.store.state.flash).toContain("say what to do with the image");
    app.input("Make the header match these\r");
    await app.idle();
    expect(runs[0]).toEqual({ goal: "Make the header match these", images: [expect.stringMatching(/^pasted-/), "shot one.png"] });
    expect(app.store.state.attachments).toBeUndefined();
    expect(screen()).toContain("▣ shot one.png · 1 KB");

    app.input(`and this one '${join(dir, "shot one.png")}'\r`);
    await app.idle();
    expect(runs[1]).toEqual({ goal: "and this one [image: shot one.png]", images: ["shot one.png"] });

    app.input("/image ./notes.txt\r");
    expect(app.store.state.flash).toContain("is not a PNG, JPEG, GIF or WebP image");
    app.input("/image ./shot one.png\r");
    app.input("/image clear\r");
    expect(app.store.state.attachments).toBeUndefined();
    expect(existsSync(join(dir, ".yxu", "images"))).toBe(true);
    app.dispose();
  });
});
