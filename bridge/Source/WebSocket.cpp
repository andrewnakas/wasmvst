#include "WebSocket.h"

namespace sha1
{
    static uint32_t rol (uint32_t v, int b) { return (v << b) | (v >> (32 - b)); }

    std::array<uint8_t, 20> digest (const void* data, size_t size)
    {
        uint32_t h[5] = { 0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0 };
        std::vector<uint8_t> msg ((const uint8_t*) data, (const uint8_t*) data + size);
        const uint64_t bitLen = (uint64_t) size * 8;
        msg.push_back (0x80);
        while (msg.size() % 64 != 56)
            msg.push_back (0);
        for (int i = 7; i >= 0; --i)
            msg.push_back ((uint8_t) (bitLen >> (i * 8)));

        for (size_t chunk = 0; chunk < msg.size(); chunk += 64)
        {
            uint32_t w[80];
            for (int i = 0; i < 16; ++i)
                w[i] = (uint32_t) msg[chunk + i * 4] << 24 | (uint32_t) msg[chunk + i * 4 + 1] << 16
                     | (uint32_t) msg[chunk + i * 4 + 2] << 8 | (uint32_t) msg[chunk + i * 4 + 3];
            for (int i = 16; i < 80; ++i)
                w[i] = rol (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);

            uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
            for (int i = 0; i < 80; ++i)
            {
                uint32_t f, k;
                if (i < 20)      { f = (b & c) | (~b & d);           k = 0x5A827999; }
                else if (i < 40) { f = b ^ c ^ d;                    k = 0x6ED9EBA1; }
                else if (i < 60) { f = (b & c) | (b & d) | (c & d);  k = 0x8F1BBCDC; }
                else             { f = b ^ c ^ d;                    k = 0xCA62C1D6; }
                const uint32_t t = rol (a, 5) + f + e + k + w[i];
                e = d; d = c; c = rol (b, 30); b = a; a = t;
            }
            h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
        }

        std::array<uint8_t, 20> out {};
        for (int i = 0; i < 5; ++i)
            for (int j = 0; j < 4; ++j)
                out[(size_t) (i * 4 + j)] = (uint8_t) (h[i] >> (24 - j * 8));
        return out;
    }
}

WebSocketConnection::WebSocketConnection (std::unique_ptr<juce::StreamingSocket> s)
    : socket (std::move (s))
{
}

bool WebSocketConnection::readExact (void* dest, size_t bytes)
{
    auto* p = static_cast<char*> (dest);
    while (bytes > 0)
    {
        const int n = socket->read (p, (int) bytes, true);
        if (n <= 0)
        {
            open = false;
            return false;
        }
        p += n;
        bytes -= (size_t) n;
    }
    return true;
}

bool WebSocketConnection::readRequest (Request& out)
{
    juce::MemoryOutputStream header;
    char c;
    // Headers are small; byte-at-a-time is fine and never over-reads into frame data.
    while (header.getDataSize() < 16384)
    {
        if (! readExact (&c, 1))
            return false;
        header.writeByte (c);
        const auto size = header.getDataSize();
        if (size >= 4 && std::memcmp ((const char*) header.getData() + size - 4, "\r\n\r\n", 4) == 0)
            break;
    }

    auto lines = juce::StringArray::fromLines (header.toString());
    if (lines.isEmpty() || ! lines[0].startsWith ("GET "))
        return false;
    out.path = lines[0].fromFirstOccurrenceOf ("GET ", false, false).upToFirstOccurrenceOf (" ", false, false);

    bool upgradeHeader = false;
    for (int i = 1; i < lines.size(); ++i)
    {
        const auto name = lines[i].upToFirstOccurrenceOf (":", false, false).trim().toLowerCase();
        const auto value = lines[i].fromFirstOccurrenceOf (":", false, false).trim();
        if (name == "sec-websocket-key")   websocketKey = value;
        else if (name == "origin")         out.origin = value;
        else if (name == "upgrade")        upgradeHeader = value.equalsIgnoreCase ("websocket");
    }
    out.isUpgrade = upgradeHeader && websocketKey.isNotEmpty();
    return true;
}

bool WebSocketConnection::acceptUpgrade()
{
    const auto keyed = websocketKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    const auto hash = sha1::digest (keyed.toRawUTF8(), keyed.getNumBytesAsUTF8());
    const auto accept = juce::Base64::toBase64 (hash.data(), hash.size());

    const juce::String response = "HTTP/1.1 101 Switching Protocols\r\n"
                                  "Upgrade: websocket\r\n"
                                  "Connection: Upgrade\r\n"
                                  "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";
    const juce::ScopedLock sl (writeLock);
    return socket->write (response.toRawUTF8(), (int) response.getNumBytesAsUTF8()) > 0;
}

void WebSocketConnection::sendHttp (int status, const juce::String& statusText, const juce::String& body)
{
    const juce::String response = "HTTP/1.1 " + juce::String (status) + " " + statusText + "\r\n"
                                  "Content-Type: text/plain\r\n"
                                  "Access-Control-Allow-Origin: *\r\n"
                                  "Access-Control-Allow-Private-Network: true\r\n"
                                  "Content-Length: " + juce::String ((int) body.getNumBytesAsUTF8()) + "\r\n"
                                  "Connection: close\r\n\r\n" + body;
    const juce::ScopedLock sl (writeLock);
    socket->write (response.toRawUTF8(), (int) response.getNumBytesAsUTF8());
    close();
}

bool WebSocketConnection::readMessage (juce::MemoryBlock& data, bool& isText)
{
    data.reset();
    bool first = true;

    for (;;)
    {
        uint8_t hdr[2];
        if (! readExact (hdr, 2))
            return false;

        const bool fin = (hdr[0] & 0x80) != 0;
        const uint8_t opcode = hdr[0] & 0x0f;
        const bool masked = (hdr[1] & 0x80) != 0;
        uint64_t len = hdr[1] & 0x7f;

        if (len == 126)
        {
            uint8_t b[2];
            if (! readExact (b, 2)) return false;
            len = (uint64_t) b[0] << 8 | b[1];
        }
        else if (len == 127)
        {
            uint8_t b[8];
            if (! readExact (b, 8)) return false;
            len = 0;
            for (auto x : b) len = len << 8 | x;
        }

        if (len > 64 * 1024 * 1024)
        {
            close();
            return false;
        }

        uint8_t mask[4] = {};
        if (masked && ! readExact (mask, 4))
            return false;

        juce::MemoryBlock payload ((size_t) len);
        if (len > 0 && ! readExact (payload.getData(), (size_t) len))
            return false;
        if (masked)
        {
            auto* p = static_cast<uint8_t*> (payload.getData());
            for (size_t i = 0; i < (size_t) len; ++i)
                p[i] ^= mask[i & 3];
        }

        if (opcode == 0x8) // close
        {
            sendFrame (0x8, nullptr, 0);
            close();
            return false;
        }
        if (opcode == 0x9) // ping
        {
            sendFrame (0xA, payload.getData(), payload.getSize());
            continue;
        }
        if (opcode == 0xA)
            continue;

        if (first)
        {
            if (opcode != 0x1 && opcode != 0x2)
                continue;
            isText = opcode == 0x1;
            first = false;
        }
        data.append (payload.getData(), payload.getSize());
        if (fin)
            return true;
    }
}

bool WebSocketConnection::sendFrame (uint8_t opcode, const void* data, size_t size)
{
    uint8_t hdr[10];
    size_t hdrLen = 2;
    hdr[0] = (uint8_t) (0x80 | opcode);
    if (size < 126)
    {
        hdr[1] = (uint8_t) size;
    }
    else if (size <= 0xffff)
    {
        hdr[1] = 126;
        hdr[2] = (uint8_t) (size >> 8);
        hdr[3] = (uint8_t) size;
        hdrLen = 4;
    }
    else
    {
        hdr[1] = 127;
        for (int i = 0; i < 8; ++i)
            hdr[2 + i] = (uint8_t) ((uint64_t) size >> (56 - i * 8));
        hdrLen = 10;
    }

    const juce::ScopedLock sl (writeLock);
    if (! open)
        return false;
    if (socket->write (hdr, (int) hdrLen) != (int) hdrLen)
        return false;
    return size == 0 || socket->write (data, (int) size) == (int) size;
}

bool WebSocketConnection::sendText (const juce::String& text)
{
    return sendFrame (0x1, text.toRawUTF8(), text.getNumBytesAsUTF8());
}

bool WebSocketConnection::sendBinary (const void* data, size_t size)
{
    return sendFrame (0x2, data, size);
}

void WebSocketConnection::close()
{
    open = false;
    socket->close();
}
