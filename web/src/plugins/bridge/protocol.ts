// Wire format shared with bridge/Source/Protocol.h — keep both in sync (see bridge/PROTOCOL.md).
export const BRIDGE_PORT = 47800;
export const BRIDGE_URL = `ws://127.0.0.1:${BRIDGE_PORT}`;

/** Bytes before MIDI/audio in a request frame: u32 seq, u16 channels, u16 frames, u16 midiCount, u16 reserved, u32 reserved. */
export const REQ_HEADER_BYTES = 16;
/** Each MIDI event: u32 sampleOffset, u8 status, u8 data1, u8 data2, u8 length. */
export const MIDI_EVENT_BYTES = 8;
/** Bytes before audio in a response frame: u32 seq, u16 channels, u16 frames, u32 latencySamples, u32 reserved. */
export const RES_HEADER_BYTES = 16;

export interface BridgePluginInfo {
  id: string;
  name: string;
  vendor: string;
  format: 'VST3' | 'AudioUnit' | string;
  category: string;
  isInstrument: boolean;
  numInputs: number;
  numOutputs: number;
}

export interface CreatedInstance {
  instanceId: number;
  name: string;
  latencySamples: number;
  numInputs: number;
  numOutputs: number;
  isInstrument: boolean;
  hasEditor: boolean;
}
