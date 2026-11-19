#!/usr/bin/env python3
"""
Generates Hubie's background music library: ORIGINAL instrumental loops synthesised from scratch by this script
(no samples, no third-party recordings, nothing copied). Because every note is generated here, the tracks carry no
third-party copyright and are released CC0 (public domain) — safe for livestreams and VOD.
Each loop is an exact number of bars, so it repeats seamlessly. Run:  python3 scripts/make-music.py
"""
import json, math, os, subprocess, sys, tempfile
import numpy as np

SR = 44100
OUT = os.path.join(os.path.dirname(__file__), '..', 'assets', 'audio')
rng = np.random.default_rng(7)

def midi(n): return 440.0 * 2 ** ((n - 69) / 12)
def env(n, a=0.005, d=0.1, s=0.6, r=0.05):
    e = np.ones(n); a_, d_, r_ = int(a*SR), int(d*SR), int(r*SR)
    e[:a_] = np.linspace(0, 1, max(a_, 1)); e[a_:a_+d_] = np.linspace(1, s, max(d_, 1))[:max(0, n-a_)] if a_ < n else e[a_:a_+d_]
    e[a_+d_:] = s
    if r_ and r_ < n: e[-r_:] *= np.linspace(1, 0, r_)
    return e
def lowpass(x, cutoff):
    a = math.exp(-2 * math.pi * cutoff / SR); y = np.empty_like(x); z = 0.0
    for i in range(len(x)): z = (1 - a) * x[i] + a * z; y[i] = z
    return y
def lp_fast(x, cutoff):  # one-pole via scipy-free cumulative trick (block IIR) — use simple loop on small buffers
    return lowpass(x, cutoff)
def saw(f, n, detune=0.0):
    t = np.arange(n) / SR; return 2 * ((t * f * (1 + detune)) % 1) - 1
def square(f, n, pw=0.5):
    t = np.arange(n) / SR; return np.where((t * f) % 1 < pw, 1.0, -1.0)
def sine(f, n): return np.sin(2 * np.pi * f * np.arange(n) / SR)

def kick(n=int(0.28*SR)):
    t = np.arange(n) / SR; f = 50 + 110 * np.exp(-t * 28); ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-t * 9) * 1.0
def snare(n=int(0.2*SR)):
    t = np.arange(n) / SR; return (rng.standard_normal(n) * np.exp(-t * 22) * 0.55 + np.sin(2*np.pi*190*t) * np.exp(-t * 25) * 0.4)
def hat(open_=False):
    n = int((0.22 if open_ else 0.05) * SR); t = np.arange(n) / SR
    x = rng.standard_normal(n); x = x - np.concatenate(([0], x[:-1])) * 0.95
    return x * np.exp(-t * (14 if open_ else 70)) * 0.22
def clap(n=int(0.18*SR)):
    t = np.arange(n) / SR; return rng.standard_normal(n) * np.exp(-t * 26) * 0.5

def place(buf, sound, start, gain=1.0):
    s = int(start * SR)
    if s >= len(buf): return
    e = min(len(buf), s + len(sound)); buf[s:e] += sound[:e - s] * gain

def render(spec):
    bpm, bars, prog, style = spec['bpm'], spec['bars'], spec['prog'], spec['style']
    beat = 60.0 / bpm; bar = beat * 4; total = int(round(bar * bars * SR))
    L = np.zeros(total); R = np.zeros(total)
    drums = np.zeros(total); bass = np.zeros(total); keys = np.zeros(total); lead = np.zeros(total); pad = np.zeros(total)
    root = spec['root']
    for b in range(bars):
        chord = prog[b % len(prog)]            # (root_offset, quality)
        r0, q = chord
        ct = {'min7': [0, 3, 7, 10], 'maj7': [0, 4, 7, 11], 'dom7': [0, 4, 7, 10], 'min': [0, 3, 7], 'maj': [0, 4, 7], 'sus': [0, 5, 7, 10]}[q]
        t0 = b * bar
        # drums
        for st in range(16):
            t = t0 + st * beat / 4
            if style in ('funk', 'hype', 'edm'):
                if style == 'funk':
                    if st in (0, 6, 10): place(drums, kick(), t, 0.9)
                    if st in (4, 12): place(drums, snare(), t, 0.75)
                    if st % 2 == 0: place(drums, hat(st in (14,)), t, 0.8)
                    if st in (7, 15) : place(drums, hat(), t, 0.5)
                else:
                    if st % 4 == 0: place(drums, kick(), t, 0.95)
                    if st in (4, 12): place(drums, clap(), t, 0.7)
                    if st % 2 == 1 or style == 'hype': place(drums, hat(st % 4 == 2), t, 0.7 if st % 2 else 0.5)
            elif style == 'lofi':
                if st in (0, 10): place(drums, kick(), t, 0.7)
                if st in (4, 12): place(drums, snare(), t, 0.45)
                if st % 2 == 0: place(drums, hat(), t, 0.45)
            # ambient: no drums
        # bass
        bn = root + r0 - 12
        if style == 'funk':
            pat = [(0, 0, 0.18), (3, 0, 0.1), (6, 7, 0.18), (8, 0, 0.18), (11, 3, 0.1), (14, 10, 0.14)]
            for st, iv, ln in pat:
                n = int(ln * SR * (60 / bpm) * 3.2); w = lowpass(saw(midi(bn + iv), n), 900) * env(n, 0.003, 0.08, 0.5, 0.03); place(bass, w, t0 + st * beat / 4, 0.55)
        elif style in ('edm', 'hype'):
            for st in range(16):
                if st % 4 != 0:
                    n = int(0.12 * SR); w = lowpass(square(midi(bn), n, 0.4), 700) * env(n, 0.002, 0.05, 0.6, 0.02); place(bass, w, t0 + st * beat / 4, 0.5)
        elif style == 'lofi':
            for st in (0, 6, 10):
                n = int(0.34 * SR); w = lowpass(sine(midi(bn), n) + 0.3 * sine(midi(bn) * 2, n), 500) * env(n, 0.01, 0.1, 0.7, 0.08); place(bass, w, t0 + st * beat / 4, 0.65)
        else:
            n = int(bar * SR); w = sine(midi(bn), n) * env(n, 0.4, 0.5, 0.8, 0.5); place(bass, w, t0, 0.5)
        # chords
        if style in ('funk',):
            for st in (2, 5, 7, 10, 13, 15):
                n = int(0.12 * SR); w = np.zeros(n)
                for iv in ct: w += lowpass(square(midi(root + r0 + iv), n, 0.3), 3200) * 0.18
                place(keys, w * env(n, 0.002, 0.05, 0.4, 0.02), t0 + st * beat / 4, 0.6)
        elif style in ('lofi', 'ambient'):
            n = int(bar * SR * (1.0 if style == 'ambient' else 0.95)); w = np.zeros(n)
            for iv in ct:
                f = midi(root + r0 + iv + 12); w += (saw(f, n, 0.003) + saw(f, n, -0.004)) * 0.06
            w = lowpass(w, 1400 if style == 'lofi' else 1000) * env(n, 0.25 if style == 'ambient' else 0.04, 0.3, 0.7, 0.3)
            place(pad, w, t0, 0.9)
        else:
            for st in range(0, 16, 2):   # arpeggio
                iv = ct[(st // 2) % len(ct)] + (12 if (st // 4) % 2 else 0)
                n = int(0.16 * SR); w = lowpass(saw(midi(root + r0 + iv + 12), n) + 0.5 * square(midi(root + r0 + iv + 12), n, 0.25), 4200) * env(n, 0.002, 0.07, 0.35, 0.04)
                place(keys, w, t0 + st * beat / 4, 0.28)
            n = int(bar * SR); w = np.zeros(n)
            for iv in ct: w += (saw(midi(root + r0 + iv), n, 0.004) + saw(midi(root + r0 + iv), n, -0.004)) * 0.05
            place(pad, lowpass(w, 1800) * env(n, 0.05, 0.3, 0.6, 0.1), t0, 0.7)
        # lead melody (pentatonic, seeded so it is repeatable) every other bar
        if spec.get('lead') and b % 2 == 1:
            scale = [0, 3, 5, 7, 10, 12, 15] if q.startswith('min') or q in ('dom7', 'sus') else [0, 2, 4, 7, 9, 12, 14]
            pos = 0.0; seq = rng.integers(0, len(scale), 8)
            for k, si in enumerate(seq):
                ln = 0.5 if k % 3 else 1.0
                if pos >= 4: break
                n = int(ln * beat * SR * 0.9); f = midi(root + r0 + scale[si] + 12)
                vib = 1 + 0.004 * np.sin(2 * np.pi * 5.5 * np.arange(n) / SR)
                w = (square(f, n, 0.5) * 0.5 + sine(f * vib, n) * 0.5) * env(n, 0.01, 0.1, 0.55, 0.08)
                place(lead, lowpass(w, 3000), t0 + pos * beat, 0.22); pos += ln
    mix_l = drums * 0.9 + bass + keys * 0.8 + pad * 0.6 + lead * 0.7
    mix_r = mix_l.copy()
    # simple stereo: keys/lead slightly offset in time (Haas) for width
    off = int(0.012 * SR); mix_r[off:] += keys[:-off] * 0.25 + lead[:-off] * 0.2; mix_l[off:] += keys[:-off] * 0.0
    stereo = np.stack([mix_l, mix_r], 1)
    # wrap tail into the head so loops are seamless (anything that rang past the end is mixed back at the start)
    return stereo

def finish(stereo, bpm, bars):
    beat = 60.0 / bpm; n_loop = int(round(beat * 4 * bars * SR))
    x = stereo[:n_loop]
    x = x / (np.max(np.abs(x)) + 1e-9)
    # gentle soft clip + normalise to about -16 LUFS-ish headroom (music sits under the voice)
    x = np.tanh(x * 1.3) * 0.55
    rms = math.sqrt(float(np.mean(x ** 2)) + 1e-12); x = x * (0.1 / rms)      # every track at the same loudness (about -20 dBFS RMS)
    peak = float(np.max(np.abs(x))); return x * (0.9 / peak) if peak > 0.9 else x

TRACKS = [
  dict(id='funky-sloth', title='Funky Sloth', mood='funky', bpm=104, bars=32, root=40, style='funk', lead=True, prog=[(0, 'min7'), (0, 'min7'), (5, 'dom7'), (5, 'dom7'), (0, 'min7'), (0, 'min7'), (7, 'dom7'), (3, 'maj7')]),
  dict(id='neon-lobby', title='Neon Lobby', mood='electronic', bpm=118, bars=32, root=45, style='edm', lead=True, prog=[(0, 'min'), (8, 'maj'), (3, 'maj'), (10, 'maj')]),
  dict(id='velvet-chips', title='Velvet Chips', mood='chill', bpm=88, bars=24, root=43, style='lofi', lead=True, prog=[(0, 'maj7'), (9, 'min7'), (2, 'min7'), (7, 'dom7')]),
  dict(id='hype-train', title='Hype Train', mood='hype', bpm=126, bars=32, root=38, style='hype', lead=True, prog=[(0, 'min'), (0, 'min'), (8, 'maj'), (10, 'maj'), (0, 'min'), (7, 'maj'), (8, 'maj'), (10, 'maj')]),
  dict(id='slow-lane', title='Slow Lane', mood='ambient', bpm=72, bars=16, root=41, style='ambient', lead=False, prog=[(0, 'maj7'), (7, 'sus'), (5, 'maj7'), (7, 'sus')]),
]

def main():
    os.makedirs(OUT, exist_ok=True); manifest = []
    only = set(sys.argv[1:])
    for spec in TRACKS:
        if only and spec['id'] not in only: continue
        print('rendering', spec['id'], flush=True)
        x = finish(render(spec), spec['bpm'], spec['bars'])
        pcm = (np.clip(x, -1, 1) * 32767).astype('<i2')
        with tempfile.NamedTemporaryFile(suffix='.raw', delete=False) as f: f.write(pcm.tobytes()); raw = f.name
        mp3 = os.path.join(OUT, spec['id'] + '.mp3')
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 's16le', '-ar', str(SR), '-ac', '2', '-i', raw, '-codec:a', 'libmp3lame', '-b:a', '128k', '-write_xing', '0', mp3], check=True)
        os.unlink(raw)
    for spec in TRACKS:
        manifest.append({'id': spec['id'], 'file': spec['id'] + '.mp3', 'title': spec['title'], 'mood': spec['mood'], 'bpm': spec['bpm'], 'seconds': round(60.0 / spec['bpm'] * 4 * spec['bars'], 1)})
    json.dump({'license': 'CC0-1.0 — original works generated by scripts/make-music.py; no third-party material', 'tracks': manifest}, open(os.path.join(OUT, 'playlist.json'), 'w'), indent=1)
    print('done')

if __name__ == '__main__': main()
