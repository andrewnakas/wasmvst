#pragma once
#include "PluginHost.h"
#include "WebSocket.h"

/**
 * Listens on 127.0.0.1 and serves two kinds of WebSocket connections:
 *   /control        JSON request/response + events (one per page)
 *   /audio/<id>     binary audio frames for one plugin instance
 */
class BridgeServer : private juce::Thread
{
public:
    explicit BridgeServer (PluginHost&, juce::StringArray extraAllowedOrigins = {});
    ~BridgeServer() override;

    bool start (int port);
    int numClients() const { return clientCount.load(); }
    juce::String getLastLog() const;

    /** Sends an event to every connected control client. */
    void broadcast (const juce::var& event);
    void log (const juce::String&);

private:
    class Connection;
    void run() override;
    bool isOriginAllowed (const juce::String& origin) const;
    void handleControl (WebSocketConnection&);
    void handleAudio (WebSocketConnection&, int instanceId);
    juce::var dispatch (const juce::var& req, juce::Array<int>& ownedInstances, WebSocketConnection&);

    PluginHost& host;
    juce::StringArray allowedOrigins;
    juce::StreamingSocket listener;
    juce::OwnedArray<Connection> connections;
    juce::CriticalSection connectionsLock, controlLock, logLock;
    juce::Array<WebSocketConnection*> controlClients;
    std::atomic<int> clientCount { 0 };
    juce::String lastLog;
};
