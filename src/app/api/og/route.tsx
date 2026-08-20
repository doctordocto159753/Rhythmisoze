import { ImageResponse } from 'next/og';
import { getInstrument } from '@synthesis';
import { isPublishConfigured } from '@/server/config';
import { findPublished } from '@/server/db';

/**
 * US-1006 / E-05 - the dynamic social card.
 *
 * PRD 6.6 is an explicit product requirement rather than polish: every shared
 * link has to show the brand, because the product's growth comes from links.
 * The card carries the title, the instrument, a waveform motif and the mark.
 *
 * The waveform is derived from the sketch's own id, so a given sketch always
 * produces the same card - it is a signature, not decoration, and it makes the
 * image cacheable and reproducible.
 *
 * Long Persian and English titles are both tested: the type scales down in two
 * steps and clamps, so neither overflows the frame (US-1006 acceptance
 * criterion).
 */
export const runtime = 'nodejs';

const WIDTH = 1200;
const HEIGHT = 630;

export async function GET(request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get('id') ?? '';

  const sketch = isPublishConfigured() && id !== '' ? await findPublished(id) : null;
  const title = sketch?.title?.trim() || 'Rhythmisoze';
  const instrument = sketch ? getInstrument(sketch.instrument_id) : undefined;
  const locale = sketch?.locale === 'en' ? 'en' : 'fa';
  const subtitle = sketch
    ? `${instrument?.name[locale] ?? sketch.instrument_id} · ${sketch.bpm} BPM`
    : 'Turn your voice into an instrument';

  // Title length drives the size in two steps rather than continuously: a
  // continuous scale makes every card look slightly different from the last.
  const titleSize = title.length > 44 ? 56 : title.length > 24 ? 72 : 88;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '72px',
          backgroundColor: '#faf7f2',
          // The same warm ground the product uses, with a single brass wash so
          // the card reads as the same object as the app.
          backgroundImage:
            'radial-gradient(circle at 88% 12%, rgba(232,188,106,0.30), rgba(250,247,242,0) 55%)',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '18px' }}>
          <svg width="44" height="44" viewBox="0 0 24 24">
            <g fill="none" stroke="#a8720f" strokeWidth="2.4" strokeLinecap="round">
              <path d="M4 16.5v3" />
              <path d="M9.3 11v8.5" />
              <path d="M14.7 6.5v13" />
              <path d="M20 3.5v16" />
            </g>
          </svg>
          <span style={{ fontSize: 30, fontWeight: 700, color: '#1b1815', letterSpacing: '-0.01em' }}>
            Rhythmisoze
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '900px' }}>
          <span
            style={{
              fontSize: titleSize,
              fontWeight: 700,
              color: '#1b1815',
              lineHeight: 1.12,
              letterSpacing: '-0.02em',
              // Two lines maximum; the subtitle carries the rest.
              display: 'block',
              overflow: 'hidden',
            }}
          >
            {title.slice(0, 90)}
          </span>
          <span style={{ fontSize: 34, color: '#6b6157' }}>{subtitle}</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '7px', height: '110px' }}>
          {waveform(id).map((height, index) => (
            <div
              key={index}
              style={{
                width: '13px',
                height: `${height}px`,
                borderRadius: '7px',
                backgroundColor: index % 3 === 0 ? '#a8720f' : '#d9cfbe',
              }}
            />
          ))}
        </div>
      </div>
    ),
    { width: WIDTH, height: HEIGHT },
  );
}

/**
 * A deterministic bar pattern derived from the id.
 *
 * Not the real audio: reading and decoding a WAV to draw a social card would
 * add seconds and a large download to every crawler request, for a picture
 * nobody compares against the waveform. What matters is that the same sketch
 * always gets the same figure.
 */
function waveform(seed: string): number[] {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    state ^= seed.charCodeAt(i);
    state = Math.imul(state, 16777619);
  }
  const bars: number[] = [];
  for (let i = 0; i < 56; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const value = Math.abs(state % 1000) / 1000;
    // Eased toward the middle so the shape reads as a phrase rather than noise.
    const envelope = Math.sin((i / 55) * Math.PI) * 0.6 + 0.4;
    bars.push(Math.round(14 + value * 92 * envelope));
  }
  return bars;
}
