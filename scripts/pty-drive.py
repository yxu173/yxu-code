"""Drive `yxu tui` in a real pseudo-terminal and reconstruct the screen.

usage: python3 scripts/pty-drive.py <cols> <rows> <cwd> <script.json> -- <command...>
script.json: [{"wait": seconds} | {"send": "text"} | {"dump": "label"} | {"until": "text", "timeout": s}]
Understands the sequences the yxu driver emits: CUP, SGR, ED, EL, alt screen, cursor show/hide.
"""
import codecs, json, os, pty, re, select, struct, sys, time, fcntl, termios

cols, rows, cwd, script_path = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4]
cmd = sys.argv[sys.argv.index("--") + 1:]
script = json.load(open(script_path))

grid = [[" "] * cols for _ in range(rows)]
cur = [0, 0]
events = {"alt_on": 0, "alt_off": 0, "paste_on": 0, "paste_off": 0, "cursor_shown_at_exit": False}
buf = ""

def feed(data):
    global buf
    buf += data
    i = 0
    while i < len(buf):
        ch = buf[i]
        if ch == "\x1b":
            m = re.match(r"\x1b\[([0-9;?]*)([A-Za-z~])", buf[i:])
            if not m:
                if len(buf) - i < 32: break
                i += 1; continue
            params, final = m.group(1), m.group(2)
            if final == "H":
                p = [int(x) if x else 1 for x in (params.split(";") if params else ["1", "1"])]
                cur[0], cur[1] = p[0] - 1, (p[1] - 1 if len(p) > 1 else 0)
            elif final == "J" and params == "2":
                for r in range(rows): grid[r] = [" "] * cols
            elif final == "K":
                if 0 <= cur[0] < rows:
                    for c in range(cur[1], cols): grid[cur[0]][c] = " "
            elif final in "hl" and params.startswith("?"):
                on = final == "h"
                if params == "?1049": events["alt_on" if on else "alt_off"] += 1
                if params == "?2004": events["paste_on" if on else "paste_off"] += 1
                if params == "?25": events["cursor_shown_at_exit"] = on
            i += m.end(); continue
        if ch in "\r\n":
            i += 1; continue
        if 0 <= cur[0] < rows and 0 <= cur[1] < cols:
            grid[cur[0]][cur[1]] = ch
            # wide chars occupy two cells
            if ord(ch) >= 0x1100 and re.match(r"[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]", ch):
                cur[1] += 1
        cur[1] += 1
        i += 1
    buf = buf[i:]

def screen():
    return "\n".join("".join(r).rstrip() for r in grid)

pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.environ.update({"TERM": "xterm-256color", "COLORTERM": "truecolor", "LANG": "en_US.UTF-8"})
    os.execvp(cmd[0], cmd)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
out = []
decoder = codecs.getincrementaldecoder("utf-8")("replace")

def pump(t):
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try: d = decoder.decode(os.read(fd, 65536))
            except OSError: return False
            if not d: return False
            out.append(d); feed(d)
    return True

alive = True
for step in script:
    if not alive: break
    if "wait" in step: alive = pump(step["wait"])
    elif "send" in step:
        os.write(fd, step["send"].encode()); alive = pump(0.15)
    elif "resize" in step:
        cols, rows = step["resize"]
        grid[:] = [[" "] * cols for _ in range(rows)]
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.kill(pid, 28)  # SIGWINCH
        alive = pump(0.4)
    elif "until" in step:
        end = time.time() + step.get("timeout", 30)
        while time.time() < end and step["until"] not in screen() and alive:
            alive = pump(0.2)
        print(f"--- until {step['until']!r}: {'found' if step['until'] in screen() else 'NOT FOUND'}")
    elif "dump" in step:
        print(f"===== {step['dump']} =====\n{screen()}\n")
alive and pump(1.0)
try:
    _, status = os.waitpid(pid, os.WNOHANG)
except ChildProcessError:
    status = 0
print("EVENTS", json.dumps(events), "exit_status", status)
