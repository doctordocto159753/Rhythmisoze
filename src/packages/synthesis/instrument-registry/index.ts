import type { NoteEvent } from '@contracts';
import { getInstrument } from '../registry';
import { preloadInstrument, renderSketch } from '../render';
import type { Instrument, InstrumentDefinition } from '../types';

export * from '../registry';
export type {
  Instrument,
  InstrumentCategory,
  InstrumentDefinition,
  InstrumentLicense,
  InstrumentQuality,
  InstrumentType,
} from '../types';

class RegisteredInstrument implements Instrument {
  readonly id: string;
  readonly name: InstrumentDefinition['name'];
  readonly category: InstrumentDefinition['category'];
  readonly type: InstrumentDefinition['type'];

  constructor(private readonly definition: InstrumentDefinition) {
    this.id = definition.id;
    this.name = definition.name;
    this.category = definition.category;
    this.type = definition.type;
  }

  async preload(context: BaseAudioContext, onProgress?: (fraction: number) => void): Promise<void> {
    await preloadInstrument(context, this.id, { onProgress });
  }

  async render(notes: readonly NoteEvent[], durationSec: number): Promise<AudioBuffer> {
    const result = await renderSketch({
      instrumentId: this.id,
      notes,
      drums: [],
      durationSec,
    });
    return result.buffer;
  }
}

/** Returns the common product-level abstraction for a registered instrument. */
export function registeredInstrument(id: string): Instrument | undefined {
  const definition = getInstrument(id);
  return definition ? new RegisteredInstrument(definition) : undefined;
}
