# Fledgling 🐣

**Sound ID for very small birds.** Point your phone at the baby and Fledgling tells you which bird he sounds like right now, with a live spectrogram, an honest match percentage, a life list, and a field guide of 36 real birds.

It's a web app (no App Store). Everything runs on the phone: recordings never leave it.

## Put it on your iPhone

1. Open the site in **Safari**.
2. Tap **Share → Add to Home Screen**.
3. Open it from the home screen, set the baby's name (⚙️), and tap **Start listening**. Allow the microphone when asked.

iOS may ask for microphone permission again each time the app is opened from the home screen. That's an iOS limit for web apps.

## How the match works

Every sound is split into **calls** (sound rising above the room's background, separated by ≥150 ms of quiet). For each call, `js/analysis.js` measures:

| Trait | What's measured |
|---|---|
| Pitch | fundamental frequency (subharmonic summation) or dominant frequency |
| Pitch shape | 16-point pitch contour + range, compared with dynamic time warping |
| Rhythm | envelope modulation spectrum (rattles, trills, pulses) + syllable count |
| Tone | spectral entropy, bandwidth, voiced fraction, 12-band timbre profile |
| Length | call duration |

`js/match.js` compares the call to ~1,000 reference calls from 216 xeno-canto recordings (6 recordists per species). The percentage is the weighted **geometric** mean of the five trait similarities, so one big mismatch drags it down hard. A bird's score is the mean of its 3 closest reference calls.

The *exact same code* analyses the reference birds (in Node, at build time) and the baby (in the browser).

## How honest is it?

`tools/build.mjs` tests the matcher on real bird calls from recordings it has never seen (leave-one-recording-out, 1,000+ calls):

- right species first: **~29%** (pure guessing: 2.8%); in the top 3: **~46%**
- most mistakes are sensible: crow↔raven, cardinal→mockingbird, sandhill crane→heron, turkey↔peafowl

With 36 birds, *some* bird will always be closest, so the labels are calibrated on calls whose species was **removed from the guide** (the baby's situation):

| Label | Sounds from outside the guide that earn it | When a real bird earns it, top pick is right |
|---|---|---|
| Strong match | 5% | ~72% |
| Good match | 15% | ~58% |
| Possible match | 40% | ~44% |

Anything weaker is shown as *Unidentified (closest: …)* and isn't logged. A species joins the life list after a good or strong match.

Each bird's page also shows the score range that real calls of that bird get, and the score the baby would need for a good or strong match.

## Rebuilding the bird data

Requires Node 18+ and `ffmpeg`.

```bash
node tools/fetch_xc.mjs        # reference recordings -> raw/ (gitignored)
node tools/fetch_photos.mjs    # one Wikimedia Commons photo per bird -> img/
node tools/build.mjs --tune    # fingerprints, honesty test, calibration -> data/, audio/, CREDITS.md
```

Edit `tools/species.mjs` to change the roster and `tools/blurbs.mjs` for the field-guide text.

## Credits

Bird recordings: xeno-canto contributors (Creative Commons; NonCommercial licences, so this is a non-commercial project). Photos: Wikimedia Commons. Full per-bird list in [CREDITS.md](CREDITS.md).
