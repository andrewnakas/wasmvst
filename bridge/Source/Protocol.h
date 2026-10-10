#pragma once
#include <cstddef>

// Wire format shared with web/src/plugins/bridge/protocol.ts — see PROTOCOL.md.
namespace protocol
{
    constexpr int kPort = 47800;
    constexpr const char* kVersion = "0.1.1";
    constexpr size_t kRequestHeaderBytes = 16;  // u32 seq, u16 channels, u16 frames, u16 midiCount, u16 0, u32 0
    constexpr size_t kMidiEventBytes = 8;       // u32 sampleOffset, u8 status, u8 d1, u8 d2, u8 length
    constexpr size_t kResponseHeaderBytes = 16; // u32 seq, u16 channels, u16 frames, u32 latencySamples, u32 0
}
