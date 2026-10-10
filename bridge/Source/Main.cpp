#include <juce_gui_basics/juce_gui_basics.h>
#include "BridgeServer.h"
#include "Protocol.h"

namespace
{
    /** Small status window: listening state, plugin count, rescan button. */
    class StatusComponent : public juce::Component, private juce::Timer
    {
    public:
        StatusComponent (PluginHost& h, BridgeServer& s, bool listening)
            : host (h), server (s)
        {
            title.setText ("wasmvst bridge", juce::dontSendNotification);
            title.setFont (juce::FontOptions (20.0f, juce::Font::bold));
            addAndMakeVisible (title);
            info.setText (listening ? "Listening on ws://127.0.0.1:" + juce::String (protocol::kPort)
                                    : "Could not open port " + juce::String (protocol::kPort) + " (already running?)",
                          juce::dontSendNotification);
            addAndMakeVisible (info);
            addAndMakeVisible (status);
            addAndMakeVisible (lastLog);
            lastLog.setColour (juce::Label::textColourId, juce::Colours::grey);

            open.setButtonText ("Open wasmvst in browser");
            open.onClick = [] { juce::URL ("https://andrewnakas.github.io/wasmvst/").launchInDefaultBrowser(); };
            addAndMakeVisible (open);

            rescan.setButtonText ("Rescan plugins");
            rescan.onClick = [this] { startScan(); };
            addAndMakeVisible (rescan);

            setSize (420, 220);
            startTimerHz (4);
            if (! host.hasCache())
                startScan();
        }

        ~StatusComponent() override
        {
            if (scanThread.joinable())
                scanThread.join();
        }

        void startScan()
        {
            if (host.isScanning())
                return;
            if (scanThread.joinable())
                scanThread.join();
            scanThread = std::thread ([this] {
                host.scan ([this] (const juce::String& name, float p) {
                    server.log ("Scanning " + name + " (" + juce::String (juce::roundToInt (p * 100)) + "%)");
                });
                server.log ("Scan finished: " + juce::String (host.numKnownPlugins()) + " plugins");
            });
        }

        void timerCallback() override
        {
            status.setText (juce::String (host.numKnownPlugins()) + " plugins known · "
                              + juce::String (server.numClients()) + " page(s) connected · "
                              + juce::String (host.numInstances()) + " instance(s)",
                            juce::dontSendNotification);
            lastLog.setText (server.getLastLog(), juce::dontSendNotification);
            rescan.setEnabled (! host.isScanning());
        }

        void paint (juce::Graphics& g) override { g.fillAll (juce::Colour (0xff1e1f22)); }

        void resized() override
        {
            auto r = getLocalBounds().reduced (16);
            title.setBounds (r.removeFromTop (30));
            info.setBounds (r.removeFromTop (24));
            status.setBounds (r.removeFromTop (24));
            lastLog.setBounds (r.removeFromTop (24));
            r.removeFromTop (12);
            auto row = r.removeFromTop (30);
            open.setBounds (row.removeFromLeft (200));
            row.removeFromLeft (8);
            rescan.setBounds (row.removeFromLeft (140));
        }

    private:
        PluginHost& host;
        BridgeServer& server;
        juce::Label title, info, status, lastLog;
        juce::TextButton open, rescan;
        std::thread scanThread;
    };

    class MainWindow : public juce::DocumentWindow
    {
    public:
        MainWindow (juce::Component* content)
            : DocumentWindow ("wasmvst bridge", juce::Colour (0xff1e1f22), DocumentWindow::closeButton | DocumentWindow::minimiseButton)
        {
            setUsingNativeTitleBar (true);
            setContentOwned (content, true);
            centreWithSize (getWidth(), getHeight());
            setVisible (true);
        }

        void closeButtonPressed() override { juce::JUCEApplication::getInstance()->systemRequestedQuit(); }
    };
}

class BridgeApplication : public juce::JUCEApplication
{
public:
    const juce::String getApplicationName() override { return "wasmvst-bridge"; }
    const juce::String getApplicationVersion() override { return protocol::kVersion; }
    bool moreThanOneInstanceAllowed() override { return false; }

    void initialise (const juce::String& commandLine) override
    {
        // --allow-origin https://example.com (repeatable) to permit other hosts of the web app.
        juce::StringArray extra, args;
        args.addTokens (commandLine, true);
        for (int i = 0; i + 1 < args.size(); ++i)
            if (args[i] == "--allow-origin")
                extra.add (args[i + 1].unquoted());

        host = std::make_unique<PluginHost>();
        server = std::make_unique<BridgeServer> (*host, extra);
        const bool listening = server->start (protocol::kPort);
        host->onChanged = [this] {
            auto* e = new juce::DynamicObject();
            e->setProperty ("event", "pluginsChanged");
            server->broadcast (juce::var (e));
        };
        window = std::make_unique<MainWindow> (new StatusComponent (*host, *server, listening));
    }

    void shutdown() override
    {
        window.reset();
        server.reset();
        host.reset();
    }

private:
    std::unique_ptr<PluginHost> host;
    std::unique_ptr<BridgeServer> server;
    std::unique_ptr<MainWindow> window;
};

START_JUCE_APPLICATION (BridgeApplication)
