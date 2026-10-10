#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>
#include <map>
#include <mutex>

/** One loaded VST3/AU plugin plus the buffers used to run it from network frames. */
class PluginInstance
{
public:
    PluginInstance (int id, std::unique_ptr<juce::AudioPluginInstance> plugin, double sampleRate, int blockSize);
    ~PluginInstance();

    /** Runs one request frame (see PROTOCOL.md) and fills the response frame. Thread-safe. */
    void process (const uint8_t* request, size_t size, juce::MemoryBlock& response);

    juce::String getStateBase64();
    void setStateBase64 (const juce::String&);

    /** Message thread only. */
    void openEditor();
    void closeEditor();
    /** Releases the plugin (message thread). Later process() calls output silence. */
    void shutdown();

    const int id;
    juce::String name;
    bool isInstrument = false, hasEditor = false;
    int numInputs = 0, numOutputs = 0;

private:
    std::unique_ptr<juce::AudioPluginInstance> plugin;
    double sampleRate;
    int blockSize;
    juce::AudioBuffer<float> buffer;
    juce::MidiBuffer midi;
    std::mutex processMutex;
    std::unique_ptr<juce::DocumentWindow> editorWindow;
};

/** Plugin discovery (cached KnownPluginList) and instance lifetime. */
class PluginHost
{
public:
    PluginHost();

    juce::var listPlugins() const;
    int numKnownPlugins() const { return known.getNumTypes(); }
    bool hasCache() const { return cacheFile.existsAsFile(); }

    /** Scans all formats' default locations. Blocking; call off the message thread. */
    void scan (std::function<void (const juce::String& name, float progress)> onProgress);
    bool isScanning() const { return scanning.load(); }

    /** Instantiates a plugin. Call off the message thread (AUv3 instantiation needs it unblocked). */
    std::shared_ptr<PluginInstance> create (const juce::String& pluginId, double sampleRate, int blockSize, juce::String& error);
    std::shared_ptr<PluginInstance> find (int id);
    void destroy (int id);
    int numInstances();

    std::function<void()> onChanged;

private:
    juce::AudioPluginFormatManager formats;
    juce::KnownPluginList known;
    juce::File cacheFile, deadMansPedal;
    std::map<int, std::shared_ptr<PluginInstance>> instances;
    std::mutex instancesMutex, scanMutex;
    std::atomic<bool> scanning { false };
    int nextId = 1;
};
