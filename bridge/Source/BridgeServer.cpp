#include "BridgeServer.h"
#include "Protocol.h"

class BridgeServer::Connection : public juce::Thread
{
public:
    Connection (BridgeServer& o, std::unique_ptr<juce::StreamingSocket> s)
        : Thread ("wasmvst-conn"), owner (o), ws (std::move (s)) {}

    ~Connection() override
    {
        ws.close();
        stopThread (2000);
    }

    void run() override
    {
        WebSocketConnection::Request req;
        if (! ws.readRequest (req))
            return;

        if (! owner.isOriginAllowed (req.origin))
        {
            owner.log ("Rejected origin " + req.origin);
            ws.sendHttp (403, "Forbidden", "origin not allowed");
            return;
        }
        if (! req.isUpgrade)
        {
            // Plain GET: lets pages/tools probe that the bridge is running.
            ws.sendHttp (200, "OK", juce::String ("wasmvst-bridge ") + protocol::kVersion);
            return;
        }
        if (! ws.acceptUpgrade())
            return;

        if (req.path == "/control")
            owner.handleControl (ws);
        else if (req.path.startsWith ("/audio/"))
            owner.handleAudio (ws, req.path.fromLastOccurrenceOf ("/", false, false).getIntValue());
        ws.close();
    }

    BridgeServer& owner;
    WebSocketConnection ws;
};

//==============================================================================
BridgeServer::BridgeServer (PluginHost& h, juce::StringArray extra)
    : Thread ("wasmvst-listener"), host (h)
{
    allowedOrigins = { "https://andrewnakas.github.io", "http://localhost", "http://127.0.0.1" };
    allowedOrigins.addArray (extra);
}

BridgeServer::~BridgeServer()
{
    signalThreadShouldExit();
    listener.close();
    stopThread (3000);
    const juce::ScopedLock sl (connectionsLock);
    connections.clear();
}

bool BridgeServer::start (int port)
{
    if (! listener.createListener (port, "127.0.0.1"))
        return false;
    startThread();
    log ("Listening on 127.0.0.1:" + juce::String (port));
    return true;
}

void BridgeServer::log (const juce::String& s)
{
    DBG (s);
    const juce::ScopedLock sl (logLock);
    lastLog = s;
}

juce::String BridgeServer::getLastLog() const
{
    const juce::ScopedLock sl (logLock);
    return lastLog;
}

bool BridgeServer::isOriginAllowed (const juce::String& origin) const
{
    if (origin.isEmpty())
        return true; // non-browser client; anything local could connect anyway
    for (auto& allowed : allowedOrigins)
    {
        // Exact match, or same scheme+host with any port ("http://localhost:5173").
        if (origin == allowed || origin.startsWith (allowed + ":"))
            return true;
    }
    return false;
}

void BridgeServer::run()
{
    while (! threadShouldExit())
    {
        std::unique_ptr<juce::StreamingSocket> client (listener.waitForNextConnection());
        if (client == nullptr)
            continue;

        const juce::ScopedLock sl (connectionsLock);
        for (int i = connections.size(); --i >= 0;)
            if (! connections[i]->isThreadRunning())
                connections.remove (i);

        auto* c = connections.add (new Connection (*this, std::move (client)));
        c->startThread (juce::Thread::Priority::high);
    }
}

void BridgeServer::broadcast (const juce::var& event)
{
    const auto text = juce::JSON::toString (event, true);
    const juce::ScopedLock sl (controlLock);
    for (auto* c : controlClients)
        c->sendText (text);
}

void BridgeServer::handleControl (WebSocketConnection& ws)
{
    {
        const juce::ScopedLock sl (controlLock);
        controlClients.add (&ws);
    }
    ++clientCount;
    log ("Page connected");

    juce::Array<int> owned; // instances created by this page are freed when it goes away
    juce::MemoryBlock data;
    bool isText = false;
    while (ws.readMessage (data, isText))
    {
        if (! isText)
            continue;
        const auto req = juce::JSON::parse (data.toString());
        juce::var reply;
        try
        {
            reply = dispatch (req, owned, ws);
        }
        catch (const std::exception& e)
        {
            auto* o = new juce::DynamicObject();
            o->setProperty ("ok", false);
            o->setProperty ("error", juce::String (e.what()));
            reply = juce::var (o);
        }
        if (auto* o = reply.getDynamicObject())
            o->setProperty ("re", req["id"]);
        ws.sendText (juce::JSON::toString (reply, true));
    }

    {
        const juce::ScopedLock sl (controlLock);
        controlClients.removeFirstMatchingValue (&ws);
    }
    --clientCount;
    for (auto id : owned)
        host.destroy (id);
    log ("Page disconnected");
}

juce::var BridgeServer::dispatch (const juce::var& req, juce::Array<int>& owned, WebSocketConnection& ws)
{
    auto* res = new juce::DynamicObject();
    juce::var result (res);
    res->setProperty ("ok", true);
    const auto type = req["type"].toString();
    auto fail = [&] (const juce::String& err) { res->setProperty ("ok", false); res->setProperty ("error", err); return result; };

    if (type == "hello")
    {
        res->setProperty ("version", protocol::kVersion);
        res->setProperty ("platform", juce::SystemStats::getOperatingSystemName());
        res->setProperty ("scanned", host.hasCache());
    }
    else if (type == "list")
    {
        res->setProperty ("plugins", host.listPlugins());
        res->setProperty ("scanning", host.isScanning());
    }
    else if (type == "scan")
    {
        log ("Scanning plugins…");
        host.scan ([&ws] (const juce::String& name, float progress) {
            auto* e = new juce::DynamicObject();
            e->setProperty ("event", "scanProgress");
            e->setProperty ("name", name);
            e->setProperty ("progress", progress);
            ws.sendText (juce::JSON::toString (juce::var (e), true));
        });
        log ("Scan finished: " + juce::String (host.numKnownPlugins()) + " plugins");
        res->setProperty ("count", host.numKnownPlugins());
    }
    else if (type == "create")
    {
        juce::String error;
        auto inst = host.create (req["pluginId"].toString(), (double) req["sampleRate"], (int) req["blockSize"], error);
        if (inst == nullptr)
            return fail (error.isEmpty() ? "failed to instantiate plugin" : error);
        owned.add (inst->id);
        log ("Loaded " + inst->name);
        res->setProperty ("instanceId", inst->id);
        res->setProperty ("name", inst->name);
        res->setProperty ("latencySamples", 0);
        res->setProperty ("numInputs", inst->numInputs);
        res->setProperty ("numOutputs", inst->numOutputs);
        res->setProperty ("isInstrument", inst->isInstrument);
        res->setProperty ("hasEditor", inst->hasEditor);
    }
    else
    {
        const int id = (int) req["instanceId"];
        auto inst = host.find (id);
        if (inst == nullptr)
            return fail ("no instance " + juce::String (id));

        if (type == "destroy")
        {
            owned.removeFirstMatchingValue (id);
            host.destroy (id);
        }
        else if (type == "openEditor")
            juce::MessageManager::callAsync ([inst] { inst->openEditor(); });
        else if (type == "closeEditor")
            juce::MessageManager::callAsync ([inst] { inst->closeEditor(); });
        else if (type == "getState")
            res->setProperty ("state", inst->getStateBase64());
        else if (type == "setState")
            inst->setStateBase64 (req["state"].toString());
        else
            return fail ("unknown request " + type);
    }
    return result;
}

void BridgeServer::handleAudio (WebSocketConnection& ws, int instanceId)
{
    auto inst = host.find (instanceId);
    if (inst == nullptr)
        return;
    log ("Audio stream for " + inst->name);

    juce::MemoryBlock data, response;
    bool isText = false;
    while (ws.readMessage (data, isText))
    {
        if (isText)
            continue;
        inst->process (static_cast<const uint8_t*> (data.getData()), data.getSize(), response);
        if (response.getSize() > 0 && ! ws.sendBinary (response.getData(), response.getSize()))
            break;
        if (host.find (instanceId) == nullptr)
            break; // destroyed
    }
}
