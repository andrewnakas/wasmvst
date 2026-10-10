#pragma once
#include <juce_core/juce_core.h>

/** Minimal RFC 6455 server-side connection over a juce::StreamingSocket (no extensions, no TLS). */
class WebSocketConnection
{
public:
    explicit WebSocketConnection (std::unique_ptr<juce::StreamingSocket> socket);

    struct Request
    {
        juce::String path, origin;
        bool isUpgrade = false;
    };

    /** Reads the HTTP request. Returns false if the socket closed or the request was malformed. */
    bool readRequest (Request& out);
    /** Completes the upgrade handshake (call after validating the request). */
    bool acceptUpgrade();
    /** Replies with a plain HTTP response and closes (used for non-WebSocket probes / rejections). */
    void sendHttp (int status, const juce::String& statusText, const juce::String& body);

    /** Blocks until a full message arrives. Returns false when the connection closes. */
    bool readMessage (juce::MemoryBlock& data, bool& isText);
    bool sendText (const juce::String& text);
    bool sendBinary (const void* data, size_t size);
    void close();
    bool isOpen() const { return open.load(); }

private:
    bool readExact (void* dest, size_t bytes);
    bool sendFrame (uint8_t opcode, const void* data, size_t size);

    std::unique_ptr<juce::StreamingSocket> socket;
    juce::String websocketKey;
    juce::CriticalSection writeLock;
    std::atomic<bool> open { true };
};

namespace sha1
{
    /** 20-byte SHA-1 digest (needed only for Sec-WebSocket-Accept). */
    std::array<uint8_t, 20> digest (const void* data, size_t size);
}
