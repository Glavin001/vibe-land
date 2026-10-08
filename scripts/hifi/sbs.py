#!/usr/bin/env python3
"""A before/after film: the runtime take (left, today's game) beside the
high-fidelity take (right), each captioned with what the headless test bed
measured for the same trial (scripts/hifi/houses.py --json): joints broken,
frame and roof held, the impactor through or stopped. Failures are captioned
as failures.

    scripts/hifi/sbs.py TRIAL RUNTIME.mp4 HIGH.mp4 OUT.mp4 [--runtime-json F] [--high-json F]

Each side is 960x540; the shorter take holds its last frame. Writes OUT and
OUT-share.mp4 (under 25 MB).
"""
import json, os, subprocess, sys, tempfile

root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
args = [a for a in sys.argv[1:] if not a.startswith('--')]
opt = {a.split('=')[0][2:]: a.split('=', 1)[1] for a in sys.argv[1:] if a.startswith('--') and '=' in a}
trial, left, right, out = args
rj = json.load(open(opt.get('runtime-json', f'{root}/target/hifi-logs/houses-runtime.json')))[trial]
hj = json.load(open(opt.get('high-json', f'{root}/target/hifi-logs/houses-high.json')))[trial]
FONT = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
FACE, BACK = 20.1, 27.9  # the veneer house's front and back brick faces (lab z)


def outcome(m):
    if trial in ('framed-house', 'framed-house-corner'):
        z = m.get('maxZ')
        if z is None: return 'truck: no measurement'
        if z >= BACK: return f'truck crosses the house ({z - BACK:.1f} m past the back wall)'
        nose = z + 2.5 - FACE
        return f'truck STALLS: its nose {nose:.1f} m into the house' if nose > 0 else f'truck STOPPED {-nose:.1f} m short of the wall'
    p = m.get('pastTarget')
    what = 'meteor' if trial.startswith('meteor') else 'balls' if trial.startswith('smallshots') else 'cannonball'
    if p is None: return f'{what}: no measurement'
    return f'{what} through ({p:.0f} m on)' if p >= 1 else f'{what} STOPPED at the wall'


def lines(m):
    held = lambda n, t: f'{t - n}/{t}'
    l1 = f"{m['broken']:,} of {m['total']:,} joints broken ({m['far8']:,} more than 8 m from the hit)"
    l2 = f"frame joints held {held(m['frame'], m['frameTotal'])} - roof joints held {held(m['roof'], m['roofTotal'])}"
    l3 = outcome(m) + (f" - {m['failedSteps']} failed step" if m.get('failedSteps') else '')
    return [l1, l2, l3]


def dur(v):
    return float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', v]))


tmp = tempfile.mkdtemp(prefix='hifi-sbs-')
files = {}
for side, title, m in (('l', "TODAY'S GAME (runtime)", rj), ('r', 'HIGH FIDELITY', hj)):
    files[side + 't'] = f'{tmp}/{side}t.txt'; open(files[side + 't'], 'w').write(title)
    for k, text in enumerate(lines(m)):
        files[f'{side}{k}'] = f'{tmp}/{side}{k}.txt'; open(files[f'{side}{k}'], 'w').write(text)
length = max(dur(left), dur(right))


def side(i, s):
    d = (f"[{i}:v]scale=960:540,setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=60,"
         f"drawbox=x=0:y=0:w=iw:h=128:color=black@0.55:t=fill,"
         f"drawtext=fontfile='{FONT}':textfile='{files[s + 't']}':x=(w-tw)/2:y=10:fontsize=24:fontcolor=white")
    for k in range(3):
        d += f",drawtext=fontfile='{FONT}':textfile='{files[f'{s}{k}']}':x=12:y=44+{k}*27:fontsize=19:fontcolor=white"
    return d + f"[{s}]"


graph = f"{side(0, 'l')};{side(1, 'r')};[l][r]hstack=inputs=2[v]"
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', left, '-i', right, '-filter_complex', graph, '-map', '[v]', '-t', f'{length:.2f}',
                '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], check=True)
share = out.replace('.mp4', '-share.mp4')
kbps = int(23.0 * 8000 / length)
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', out, '-c:v', 'libx264', '-b:v', f'{kbps}k', '-maxrate', f'{kbps * 3 // 2}k', '-bufsize', f'{kbps * 2}k',
                '-pix_fmt', 'yuv420p', '-movflags', '+faststart', share], check=True)
print(out); print(share)
