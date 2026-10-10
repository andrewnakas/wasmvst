#include "PluginHost.h"
#include "Protocol.h"

namespace
{
    class EditorWindow : public juce::DocumentWindow
    {
    public:
        EditorWindow (const juce::String& title, juce::AudioProcessorEditor* editor, std::function<void()> onCloseIn)
            : DocumentWindow (title, juce::Colours::darkgrey, DocumentWindow::closeButton | DocumentWindow::minimiseButton),
              onClose (std::move (onCloseIn))
        {
            setUsingNativeTitleBar (true);
            setContentOwned (editor, true);
            setResizable (editor->isResizable(), false);
            centreWithSize (getWidth(), getHeight());
            setAlwaysOnTop (true);
            setVisible (true);
            juce::Process::makeForegroundProcess();
            toFront (true);
        }

        void closeButtonPressed() override
        {
            // Defer: the callback must not delete this window while it's on the stack.
            juce::MessageManager::callAsync (onClose);
        }

    private:
        std::function<void()> onClose;
    };

    template <typename T>
    T readLE (const uint8_t* p)
    {
        T v;
        std::memcpy (&v, p, sizeof (T)); // all supported hosts are little-endian
        return v;
    }

    template <typename T>
    void writeLE (uint8_t* p, T v) { std::memcpy (p, &v, sizeof (T)); }
}

//==============================================================================
PluginInstance::PluginInstance (int idIn, std::unique_ptr<juce::AudioPluginInstance> p, double sr, int bs)
    : id (idIn), plugin (std::move (p)), sampleRate (sr), blockSize (bs)
{
    name = plugin->getName();
    isInstrument = plugin->getPluginDescription().isInstrument || plugin->acceptsMidi() && plugin->getTotalNumInputChannels() == 0;
    hasEditor = plugin->hasEditor();

    plugin->enableAllBuses();
    auto layout = plugin->getBusesLayout();
    if (! layout.inputBuses.isEmpty())  layout.inputBuses.getReference (0) = juce::AudioChannelSet::stereo();
    if (! layout.outputBuses.isEmpty()) layout.outputBuses.getReference (0) = juce::AudioChannelSet::stereo();
    if (plugin->checkBusesLayoutSupported (layout))
        plugin->setBusesLayout (layout);

    numInputs = plugin->getTotalNumInputChannels();
    numOutputs = plugin->getTotalNumOutputChannels();
    plugin->setRateAndBufferSizeDetails (sampleRate, blockSize);
    plugin->prepareToPlay (sampleRate, blockSize);
    buffer.setSize (juce::jmax (2, numInputs, numOutputs), blockSize);
    midi.ensureSize (2048);
}

PluginInstance::~PluginInstance()
{
    jassert (plugin == nullptr || juce::MessageManager::getInstance()->isThisTheMessageThread());
}

void PluginInstance::shutdown()
{
    editorWindow.reset();
    std::lock_guard<std::mutex> lock (processMutex);
    if (plugin != nullptr)
    {
        plugin->releaseResources();
        plugin.reset();
    }
}

void PluginInstance::process (const uint8_t* req, size_t size, juce::MemoryBlock& response)
{
    using namespace protocol;
    if (size < kRequestHeaderBytes)
        return;

    const auto seq     = readLE<uint32_t> (req);
    const int nCh      = readLE<uint16_t> (req + 4);
    const int nFrames  = readLE<uint16_t> (req + 6);
    const int nMidi    = readLE<uint16_t> (req + 8);
    const size_t audioOffset = kRequestHeaderBytes + (size_t) nMidi * kMidiEventBytes;
    if (size < audioOffset + (size_t) nCh * (size_t) nFrames * sizeof (float) || nFrames == 0)
        return;

    response.setSize (kResponseHeaderBytes + 2 * (size_t) nFrames * sizeof (float), true);
    auto* res = static_cast<uint8_t*> (response.getData());
    writeLE<uint32_t> (res, seq);
    writeLE<uint16_t> (res + 4, 2);
    writeLE<uint16_t> (res + 6, (uint16_t) nFrames);
    auto* outAudio = res + kResponseHeaderBytes;

    std::lock_guard<std::mutex> lock (processMutex);
    if (plugin == nullptr)
        return; // silence

    if (nFrames > blockSize)
    {
        blockSize = nFrames;
        plugin->prepareToPlay (sampleRate, blockSize);
    }

    const int totalIn = plugin->getTotalNumInputChannels();
    const int totalOut = plugin->getTotalNumOutputChannels();
    buffer.setSize (juce::jmax (2, totalIn, totalOut), nFrames, false, false, true);
    buffer.clear();
    for (int c = 0; c < juce::jmin (nCh, totalIn); ++c)
        std::memcpy (buffer.getWritePointer (c), req + audioOffset + (size_t) c * (size_t) nFrames * sizeof (float), (size_t) nFrames * sizeof (float));

    midi.clear();
    for (int i = 0; i < nMidi; ++i)
    {
        const auto* ev = req + kRequestHeaderBytes + (size_t) i * kMidiEventBytes;
        const int offset = juce::jlimit (0, nFrames - 1, (int) readLE<uint32_t> (ev));
        const int len = juce::jlimit (1, 3, (int) ev[7]);
        midi.addEvent (ev + 4, len, offset);
    }

    {
        const juce::ScopedLock cb (plugin->getCallbackLock());
        if (plugin->isSuspended())
            buffer.clear();
        else
            plugin->processBlock (buffer, midi);
    }

    for (int c = 0; c < 2; ++c)
    {
        if (totalOut == 0)
            break;
        std::memcpy (outAudio + (size_t) c * (size_t) nFrames * sizeof (float),
                     buffer.getReadPointer (juce::jmin (c, totalOut - 1)), (size_t) nFrames * sizeof (float));
    }
    writeLE<uint32_t> (res + 8, (uint32_t) plugin->getLatencySamples());
}

juce::String PluginInstance::getStateBase64()
{
    juce::MemoryBlock mb;
    std::lock_guard<std::mutex> lock (processMutex);
    if (plugin != nullptr)
        plugin->getStateInformation (mb);
    return mb.toBase64Encoding();
}

void PluginInstance::setStateBase64 (const juce::String& s)
{
    juce::MemoryBlock mb;
    if (! mb.fromBase64Encoding (s))
        return;
    std::lock_guard<std::mutex> lock (processMutex);
    if (plugin != nullptr)
        plugin->setStateInformation (mb.getData(), (int) mb.getSize());
}

void PluginInstance::openEditor()
{
    if (editorWindow != nullptr)
    {
        editorWindow->toFront (true);
        return;
    }
    if (plugin == nullptr || ! plugin->hasEditor())
        return;
    if (auto* editor = plugin->createEditorIfNeeded())
        editorWindow = std::make_unique<EditorWindow> (name, editor, [this] { closeEditor(); });
}

void PluginInstance::closeEditor()
{
    editorWindow.reset();
}

//==============================================================================
PluginHost::PluginHost()
{
    formats.addDefaultFormats();
    auto dir = juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory).getChildFile ("wasmvst-bridge");
    dir.createDirectory();
    cacheFile = dir.getChildFile ("plugins.xml");
    deadMansPedal = dir.getChildFile ("scanning.txt");
    if (auto xml = juce::XmlDocument::parse (cacheFile))
        known.recreateFromXml (*xml);
}

juce::var PluginHost::listPlugins() const
{
    juce::Array<juce::var> list;
    for (const auto& d : known.getTypes())
    {
        auto* o = new juce::DynamicObject();
        o->setProperty ("id", d.createIdentifierString());
        o->setProperty ("name", d.name);
        o->setProperty ("vendor", d.manufacturerName);
        o->setProperty ("format", d.pluginFormatName);
        o->setProperty ("category", d.category);
        o->setProperty ("isInstrument", d.isInstrument);
        o->setProperty ("numInputs", d.numInputChannels);
        o->setProperty ("numOutputs", d.numOutputChannels);
        list.add (juce::var (o));
    }
    return list;
}

void PluginHost::scan (std::function<void (const juce::String&, float)> onProgress)
{
    std::lock_guard<std::mutex> lock (scanMutex);
    scanning = true;
    for (auto* format : formats.getFormats())
    {
        juce::PluginDirectoryScanner scanner (known, *format, format->getDefaultLocationsToSearch(), true, deadMansPedal, false);
        juce::String next;
        for (;;)
        {
            next = scanner.getNextPluginFileThatWillBeScanned();
            if (onProgress)
                onProgress (format->getName() + ": " + juce::File::createFileWithoutCheckingPath (next).getFileNameWithoutExtension(), scanner.getProgress());
            if (! scanner.scanNextFile (true, next))
                break;
        }
    }
    if (auto xml = known.createXml())
        xml->writeTo (cacheFile);
    scanning = false;
    if (onChanged)
        onChanged();
}

std::shared_ptr<PluginInstance> PluginHost::create (const juce::String& pluginId, double sampleRate, int blockSize, juce::String& error)
{
    auto desc = known.getTypeForIdentifierString (pluginId);
    if (desc == nullptr)
    {
        error = "Unknown plugin " + pluginId + " (rescan?)";
        return nullptr;
    }

    auto plugin = formats.createPluginInstance (*desc, sampleRate, blockSize, error);
    if (plugin == nullptr)
        return nullptr;

    int id;
    {
        std::lock_guard<std::mutex> lock (instancesMutex);
        id = nextId++;
    }
    // Constructing (bus layout, prepareToPlay) on the message thread keeps picky AUs happy.
    // Not under instancesMutex: the message thread may need it meanwhile.
    std::shared_ptr<PluginInstance> inst;
    juce::MessageManager::callSync ([&] {
        inst = std::make_shared<PluginInstance> (id, std::move (plugin), sampleRate, blockSize);
    });
    {
        std::lock_guard<std::mutex> lock (instancesMutex);
        instances[id] = inst;
    }
    if (onChanged)
        onChanged();
    return inst;
}

std::shared_ptr<PluginInstance> PluginHost::find (int id)
{
    std::lock_guard<std::mutex> lock (instancesMutex);
    auto it = instances.find (id);
    return it != instances.end() ? it->second : nullptr;
}

void PluginHost::destroy (int id)
{
    std::shared_ptr<PluginInstance> inst;
    {
        std::lock_guard<std::mutex> lock (instancesMutex);
        auto it = instances.find (id);
        if (it == instances.end())
            return;
        inst = it->second;
        instances.erase (it);
    }
    juce::MessageManager::callAsync ([inst] { inst->shutdown(); });
    if (onChanged)
        onChanged();
}

int PluginHost::numInstances()
{
    std::lock_guard<std::mutex> lock (instancesMutex);
    return (int) instances.size();
}
