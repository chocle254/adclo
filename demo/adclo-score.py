"""AdClo demo score — original composition, synthesized from scratch in numpy.

No samples, loops or third-party audio are used: every sound below is generated
from sine waves and noise, so the track is the author's own work (released CC0).

Key of F major, 96 BPM. Loop: Dm7 - Bbmaj7 - Fmaj7 - Csus4/C (vi-IV-I-V),
resolving to Fmaj9 at the end. Layers follow the video:
  0-27.7s    pain       soft pad + sparse bell notes
  27.7s      Marcus     arpeggio and bass come in
  ~40s       groove     soft kick, shaker, rim
  106.7s     Grace      two-bar breath (drums out), then back
  151.6s     summary    brighter: extra high arpeggio octave
  167.0s     end card   drums out, cadence to F, fade
"""
import sys
import numpy as np
from scipy.signal import fftconvolve, butter, sosfilt
from scipy.io import wavfile

SR = 48000
DUR = float(sys.argv[2]) if len(sys.argv) > 2 else 175.9
OUT = sys.argv[1]
BPM = 96
BEAT = 60 / BPM          # 0.625 s
BAR = 4 * BEAT           # 2.5 s
N = int(DUR * SR)
rng = np.random.default_rng(254)

T_MARCUS, T_GROOVE, T_GRACE, T_SUMMARY, T_END = 27.7, 40.0, 106.7, 151.6, 167.0

def midi(m): return 440.0 * 2 ** ((m - 69) / 12)

# Chord voicings (MIDI). root for bass, pad notes, arp notes.
CH = {
    "Dm7":    (38, [50, 57, 60, 65], [62, 65, 69, 72, 69, 65]),
    "Bbmaj7": (34, [50, 53, 57, 62], [58, 62, 65, 69, 65, 62]),
    "Fmaj7":  (41, [48, 52, 57, 60], [60, 64, 69, 72, 69, 64]),
    "Csus":   (36, [48, 53, 55, 60], [60, 65, 67, 72, 67, 65]),
    "C":      (36, [48, 52, 55, 60], [60, 64, 67, 72, 67, 64]),
    "Fmaj9":  (41, [48, 52, 55, 57, 60], [60, 64, 67, 69, 72, 76]),
}
LOOP = ["Dm7", "Bbmaj7", "Fmaj7", "Csus"]
nbars = int(np.ceil(DUR / BAR)) + 1
chords = [LOOP[i % 4] for i in range(nbars)]
# Cadence: bar 66 (165s) Bb, 67 C, 68+ Fmaj9
chords[66], chords[67] = "Bbmaj7", "C"
for i in range(68, nbars): chords[i] = "Fmaj9"
# In the loop, the 4th bar moves Csus -> C on beat 3 (handled in pad/arp by swapping tones)

def env_lin(points, n=N):
    """piecewise-linear automation from [(t, value), ...]"""
    ts, vs = zip(*points)
    return np.interp(np.arange(n) / SR, ts, vs).astype(np.float32)

def adsr(n, a, r, sr=SR):
    e = np.ones(n, np.float32)
    na, nr = int(a * sr), int(r * sr)
    na = min(na, n); e[:na] = np.linspace(0, 1, na)
    if nr > 0:
        nr = min(nr, n); e[-nr:] *= np.linspace(1, 0, nr)
    return e

L = np.zeros(N, np.float32); R = np.zeros(N, np.float32)

def add(buf, start, sig):
    i = int(start * SR)
    if i >= N: return
    j = min(N, i + len(sig))
    buf[i:j] += sig[: j - i]

def pan_add(start, sig, pan):  # pan -1..1, equal power
    a = (pan + 1) * np.pi / 4
    add(L, start, sig * np.cos(a)); add(R, start, sig * np.sin(a))

# ---------- pad: soft additive "string/choir" with slow motion ----------
def pad_note(f, dur, bright):
    n = int(dur * SR); t = np.arange(n) / SR
    s = np.zeros(n, np.float32)
    for det in (-0.06, 0.0, 0.07):           # detune in semitone fractions (~6 cents)
        fd = f * 2 ** (det / 12)
        ph = rng.uniform(0, 2 * np.pi)
        for h in range(1, 7):
            amp = (1 / h ** (2.2 - bright))
            vib = 1 + 0.0015 * np.sin(2 * np.pi * 0.23 * t + h)
            s += amp * np.sin(2 * np.pi * fd * h * t * vib + ph * h)
    return s * adsr(n, 1.1, 1.3) / 15

pad_bright = lambda t: 0.0 if t < T_SUMMARY else 0.4
for b in range(nbars):
    t0 = b * BAR
    if t0 >= DUR: break
    name = chords[b]
    length = BAR + 1.3
    if name == "Fmaj9": length = DUR - t0 + 0.5
    if b > 68 and name == "Fmaj9": continue      # one long final chord
    _, notes, _ = CH[name]
    for k, m in enumerate(notes):
        sig = pad_note(midi(m), length, pad_bright(t0))
        pan_add(t0, sig, -0.5 + k / max(1, len(notes) - 1))

# ---------- bell/felt-piano tone ----------
def keys(f, dur=1.8, vel=1.0):
    n = int(dur * SR); t = np.arange(n) / SR
    s = (np.sin(2 * np.pi * f * t) * np.exp(-t * 2.2)
         + 0.35 * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t * 4.0)
         + 0.12 * np.sin(2 * np.pi * 3.01 * f * t) * np.exp(-t * 7.0)
         + 0.05 * np.sin(2 * np.pi * 4.2 * f * t) * np.exp(-t * 11))
    att = np.minimum(1, t / 0.004)           # soft hammer
    return (s * att * vel).astype(np.float32)

# sparse bell notes in the pain section: one per bar, top chord tone
for b in range(int(T_MARCUS / BAR) + 1):
    t0 = b * BAR + BEAT
    if t0 > T_MARCUS: break
    m = CH[chords[b]][2][3]
    pan_add(t0, keys(midi(m), 3.0, 0.5), 0.25)
    pan_add(t0 + 2 * BEAT, keys(midi(CH[chords[b]][2][1]), 2.5, 0.32), -0.25)

# arpeggio: eighth notes from Marcus onward
eighth = BEAT / 2
arp_lvl = env_lin([(0, 0), (T_MARCUS - 0.1, 0), (T_MARCUS + BAR * 2, 0.6),
                   (T_END, 0.6), (DUR, 0.42)])
t = T_MARCUS - (T_MARCUS % eighth)
step = 0
while t < DUR - 1.0:
    b = int(t // BAR)
    name = chords[b]
    # last bar of loop: Csus resolves to C on beat 3
    if name == "Csus" and (t % BAR) >= 2 * BEAT: name = "C"
    arp = CH[name][2]
    lvl = float(arp_lvl[min(N - 1, int(t * SR))])
    if t >= DUR - 9.0 and name == "Fmaj9":       # slow it down at the very end
        if step % 2: t += eighth; step += 1; continue
    m = arp[step % len(arp)]
    swing = 0.018 if step % 2 else 0.0
    vel = lvl * (1.0 if step % 4 == 0 else 0.72)
    pan_add(t + swing, keys(midi(m), 1.6, vel), 0.35 if step % 2 else -0.15)
    if t >= T_SUMMARY and t < T_END and step % 2 == 0:   # summary: high sparkle octave
        pan_add(t + swing, keys(midi(m + 12), 1.2, vel * 0.35), 0.55)
    t += eighth; step += 1

# final chord ring on the end card
pan_add((68) * BAR, keys(midi(77), 6.0, 0.30), 0.3)

# ---------- bass ----------
def bass_note(f, dur, vel):
    n = int(dur * SR); t = np.arange(n) / SR
    s = np.sin(2 * np.pi * f * t) + 0.25 * np.sin(2 * np.pi * 2 * f * t)
    s = np.tanh(1.4 * s) * adsr(n, 0.015, 0.25) * np.exp(-t * 0.7)
    return (s * vel).astype(np.float32)

bass_lvl = env_lin([(0, 0), (T_MARCUS, 0), (T_MARCUS + 4, 0.5), (DUR - 3, 0.5), (DUR, 0)])
for b in range(nbars):
    t0 = b * BAR
    if t0 < T_MARCUS - 0.01 or t0 >= DUR: continue
    root = CH[chords[b]][0]
    v = float(bass_lvl[min(N - 1, int(t0 * SR))])
    if chords[b] == "Fmaj9":
        pan_add(t0, bass_note(midi(root), DUR - t0, v), 0); continue
    pan_add(t0, bass_note(midi(root), 1.4, v), 0)
    pan_add(t0 + 2.5 * BEAT, bass_note(midi(root), 0.55, v * 0.7), 0)
    pan_add(t0 + 3 * BEAT, bass_note(midi(root + (7 if chords[b] != "Csus" else 0)), 0.6, v * 0.75), 0)

# ---------- drums ----------
def kick():
    n = int(0.35 * SR); t = np.arange(n) / SR
    f = 45 + 75 * np.exp(-t * 30)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return (np.sin(ph) * np.exp(-t * 9)).astype(np.float32)

hp = butter(4, 6500, "hp", fs=SR, output="sos")
bp = butter(2, [900, 3500], "bp", fs=SR, output="sos")
def shaker():
    n = int(0.07 * SR); t = np.arange(n) / SR
    s = sosfilt(hp, rng.standard_normal(n)) * np.exp(-t * 60) * np.minimum(1, t / 0.008)
    return s.astype(np.float32)
def rim():
    n = int(0.12 * SR); t = np.arange(n) / SR
    s = sosfilt(bp, rng.standard_normal(n)) * np.exp(-t * 40) + 0.4 * np.sin(2 * np.pi * 820 * t) * np.exp(-t * 60)
    return s.astype(np.float32)

KICK = kick()
def drums_on(t):
    if t < T_GROOVE or t >= T_END: return 0.0
    if T_GRACE <= t < T_GRACE + 2 * BAR: return 0.0      # breath for Grace's intro
    ramp = min(1.0, (t - T_GROOVE) / (2 * BAR))
    return ramp

t0 = (T_GROOVE // BAR) * BAR
b = int(t0 // BAR)
while b * BAR < T_END:
    tb = b * BAR
    for beat in range(4):
        tt = tb + beat * BEAT
        g = drums_on(tt)
        if g == 0: continue
        if beat in (0, 2): pan_add(tt, KICK * 0.55 * g, 0)
        if beat in (1, 3): pan_add(tt + 0.01, rim() * 0.16 * g, 0.1)
        for e in range(2):
            ts = tt + e * eighth + (0.02 if e else 0)
            pan_add(ts, shaker() * (0.10 if e else 0.06) * g, 0.4)
    b += 1

# ---------- master: reverb, gentle lowpass on the pain section, fade ----------
ir_n = int(2.6 * SR); ti = np.arange(ir_n) / SR
irL = (rng.standard_normal(ir_n) * np.exp(-ti * 2.6)).astype(np.float32)
irR = (rng.standard_normal(ir_n) * np.exp(-ti * 2.6)).astype(np.float32)
lp_ir = butter(1, 5000, "lp", fs=SR, output="sos")
irL = sosfilt(lp_ir, irL).astype(np.float32); irR = sosfilt(lp_ir, irR).astype(np.float32)
irL /= np.sqrt((irL ** 2).sum()); irR /= np.sqrt((irR ** 2).sum())
wetL = fftconvolve(L, irL)[:N].astype(np.float32)
wetR = fftconvolve(R, irR)[:N].astype(np.float32)
mixL = L + 0.28 * wetL; mixR = R + 0.28 * wetR

# darker during the pain section, opens up when the solution arrives
lp_dark = butter(2, 1800, "lp", fs=SR, output="sos")
darkL, darkR = sosfilt(lp_dark, mixL), sosfilt(lp_dark, mixR)
x = env_lin([(0, 1), (T_MARCUS - 3, 1), (T_MARCUS + 1, 0), (DUR, 0)])
mixL = x * darkL + (1 - x) * mixL; mixR = x * darkR + (1 - x) * mixR

master = env_lin([(0, 0), (2.5, 1), (DUR - 4.0, 1), (DUR, 0)])
st = np.stack([mixL * master, mixR * master], 1)
st /= np.abs(st).max() / 0.89
wavfile.write(OUT, SR, st.astype(np.float32))
print("wrote", OUT, f"{DUR:.1f}s")
