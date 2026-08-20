import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { NextResponse } from 'next/server';
import { isPublishConfigured, MAX_AUDIO_BYTES, MAX_MIDI_BYTES } from '@/server/config';
import { objectPrefix, verifyTicket } from '@/server/publish';

/**
 * US-1003, step 2 - the upload-token route.
 *
 * The file itself never passes through this function. The client asks for a
 * scoped token, uploads straight to blob storage, and the Function only ever
 * sees a few hundred bytes of JSON. That is what keeps publishing under
 * Vercel's 4.5 MB request-body limit for a 10 MB WAV, and it is the shape the
 * playbook requires ("do not proxy large WAV files through a Function").
 *
 * Everything a client could otherwise choose freely is pinned here:
 *
 *  - **where** it can write: only `sketches/<id>/audio.wav` or
 *    `sketches/<id>/sketch.mid`, and only for an `<id>` carried by a ticket
 *    this server signed;
 *  - **what** it can write: `audio/wav` or `audio/midi`, nothing else, so the
 *    store cannot be used to host an executable or an HTML page;
 *  - **how much**: the per-file caps from config.
 */
export const runtime = 'nodejs';

const ALLOWED_FILES = new Set(['audio.wav', 'sketch.mid']);

export async function POST(request: Request): Promise<Response> {
  if (!isPublishConfigured()) {
    return NextResponse.json({ error: 'publishing_disabled' }, { status: 503 });
  }

  const body = (await request.json()) as HandleUploadBody;

  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const ticket = verifyTicket(typeof clientPayload === 'string' ? clientPayload : '');
        if (ticket === null) throw new Error('invalid_ticket');

        const prefix = objectPrefix(ticket.id);
        if (!pathname.startsWith(prefix)) throw new Error('pathname_outside_prefix');

        const filename = pathname.slice(prefix.length);
        if (!ALLOWED_FILES.has(filename)) throw new Error('unexpected_filename');

        const isAudio = filename === 'audio.wav';
        return {
          allowedContentTypes: isAudio ? ['audio/wav'] : ['audio/midi', 'audio/mid'],
          maximumSizeInBytes: isAudio ? MAX_AUDIO_BYTES : MAX_MIDI_BYTES,
          // The pathname is already unique per sketch and must stay predictable,
          // because `POST /api/publish` verifies the returned URL against it.
          addRandomSuffix: false,
          tokenPayload: JSON.stringify({ id: ticket.id }),
        };
      },
      onUploadCompleted: async () => {
        // Nothing to do. The record is written by `POST /api/publish` once the
        // client confirms both uploads, and this callback does not fire on a
        // local development host at all - relying on it would make the flow
        // untestable outside production.
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'upload_rejected';
    return NextResponse.json({ error: reason }, { status: 400 });
  }
}
