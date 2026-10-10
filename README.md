# wasmvst

A clean-room, browser-based DAW (a long-term Ableton Live–style project) that loads plugins in two ways:

| Plugin type | How it runs | Install needed |
|---|---|---|
| **Web plugins (WebAudio Modules 2.0)** | In the page, as AudioWorklets. The 50+ plugins in the WAM community catalog, or any WAM2 module URL | none |
| **Native VST3 / Audio Unit** | In **wasmvst-bridge**, a small native helper app. The page streams audio and MIDI to it over a localhost WebSocket, and the plugin's real GUI opens as a native window | the bridge |

**Live:** https://andrewnakas.github.io/wasmvst/

## Why native plugins need a bridge

A `.vst3` or `.component` file is compiled machine code that calls the operating system's audio and GUI APIs
directly, and often checks licenses (iLok and similar). The browser sandbox, WebAssembly included, can't load or run
that code. So the bridge hosts the plugins natively and the page drives them:

```
browser: track → AudioWorklet ⇄ SharedArrayBuffer ring ⇄ Worker ⇄ ws://127.0.0.1:47800 ⇄ wasmvst-bridge → VST3/AU
```

The round trip adds about 15–30 ms of latency, which each mixer strip shows. Details are in [bridge/PROTOCOL.md](bridge/PROTOCOL.md).

## Using it

1. Open the site, click **Start audio**, and play the selected track with your computer keyboard (A–K, Z/X for octave) or a MIDI controller.
2. **Web (WAM)** tab: click an instrument or effect to add it to the selected track. Click a plugin's name in the strip to open its GUI.
3. **VST3 / AU** tab: download `wasmvst-bridge` from [Releases](https://github.com/andrewnakas/wasmvst/releases/latest), unzip it, then right-click it → **Open** (it's unsigned). The page connects automatically. If Chrome asks about local network access, allow it.

Chrome and Edge are the supported browsers. Safari may block `ws://127.0.0.1` from https pages.

## Development

```sh
# web app
cd web && npm install && npm run dev        # http://localhost:5173

# bridge (macOS, needs Xcode + CMake; downloads JUCE 8)
cd bridge && cmake -B build -G Xcode && cmake --build build --config Release
open build/wasmvst-bridge_artefacts/Release/wasmvst-bridge.app
```

Project layout:
- `web/src/engine`: AudioContext, tracks, insert chains, transport
- `web/src/plugins`: the `PluginSlot` interface, plus the built-in, WAM, and bridge implementations
- `web/src/ui`: browser, mixer, plugin windows, keyboard
- `bridge/Source`: the JUCE host, a minimal WebSocket server, and the plugin instances

The bridge uses JUCE, which is licensed under AGPLv3 for open-source use.
