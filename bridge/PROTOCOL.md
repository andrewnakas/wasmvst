# wasmvst bridge protocol (v0.1)

The bridge listens on `127.0.0.1:47800` (loopback only). The `Origin` header must be
`https://andrewnakas.github.io` or `http://localhost[:port]` / `http://127.0.0.1[:port]`,
or one added with `--allow-origin <origin>`. A plain `GET /` returns `200 wasmvst-bridge <version>`.

## Control: `ws://127.0.0.1:47800/control`

The page sends JSON text messages `{ "id": <n>, "type": "...", ...args }`. Every one gets the reply
`{ "re": <n>, "ok": true, ... }` or `{ "re": <n>, "ok": false, "error": "..." }`.

| type          | args                                   | reply fields |
|---------------|----------------------------------------|--------------|
| `hello`       | —                                      | `version`, `platform`, `scanned` |
| `list`        | —                                      | `plugins: [{id, name, vendor, format, category, isInstrument, numInputs, numOutputs}]`, `scanning` |
| `scan`        | —                                      | `count` (sends `scanProgress` events while it runs) |
| `create`      | `pluginId`, `sampleRate`, `blockSize`  | `instanceId`, `name`, `latencySamples`, `numInputs`, `numOutputs`, `isInstrument`, `hasEditor` |
| `destroy`     | `instanceId`                           | — |
| `openEditor`  | `instanceId`                           | — (the plugin's native window opens on the desktop) |
| `closeEditor` | `instanceId`                           | — |
| `getState`    | `instanceId`                           | `state` (base64 of the plugin's state chunk) |
| `setState`    | `instanceId`, `state`                  | — |

Events sent by the bridge without a request: `{ "event": "scanProgress", name, progress }` and
`{ "event": "pluginsChanged" }`.

The bridge destroys any instance a control connection created when that connection closes.

## Audio: `ws://127.0.0.1:47800/audio/<instanceId>`

The page sends binary frames, and the bridge answers each one with exactly one frame. All values are
little-endian, and audio is planar float32.

Request:
```
u32 seq | u16 channels | u16 frames | u16 midiCount | u16 0 | u32 0       (16 bytes)
midiCount × [ u32 sampleOffset | u8 status | u8 data1 | u8 data2 | u8 length ]
channels × frames × f32
```

Response:
```
u32 seq | u16 channels(=2) | u16 frames | u32 pluginLatencySamples | u32 0   (16 bytes)
2 × frames × f32
```

The bridge processes one frame per request, synchronously on that connection's thread, so the browser's
audio clock drives the plugin and the two sides can't drift apart.
