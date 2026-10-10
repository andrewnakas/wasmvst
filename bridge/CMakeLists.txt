cmake_minimum_required(VERSION 3.22)
project(wasmvst_bridge VERSION 0.1.0 LANGUAGES C CXX OBJC OBJCXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "")

# Point JUCE_DIR at a local checkout to skip the download.
set(JUCE_DIR "" CACHE PATH "Path to a JUCE 8 checkout")
if(JUCE_DIR)
  add_subdirectory(${JUCE_DIR} JUCE)
else()
  include(FetchContent)
  FetchContent_Declare(JUCE
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG 8.0.9
    GIT_SHALLOW TRUE)
  FetchContent_MakeAvailable(JUCE)
endif()

juce_add_gui_app(wasmvst-bridge
  PRODUCT_NAME "wasmvst-bridge"
  COMPANY_NAME "wasmvst"
  BUNDLE_ID "io.github.andrewnakas.wasmvst-bridge"
  VERSION ${PROJECT_VERSION})

target_sources(wasmvst-bridge PRIVATE
  Source/Main.cpp
  Source/WebSocket.cpp
  Source/PluginHost.cpp
  Source/BridgeServer.cpp)

target_compile_definitions(wasmvst-bridge PRIVATE
  JUCE_PLUGINHOST_VST3=1
  JUCE_PLUGINHOST_AU=1
  JUCE_PLUGINHOST_LADSPA=0
  JUCE_WEB_BROWSER=0
  JUCE_USE_CURL=0
  JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:wasmvst-bridge,JUCE_PRODUCT_NAME>"
  JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:wasmvst-bridge,JUCE_VERSION>")

target_link_libraries(wasmvst-bridge PRIVATE
  juce::juce_audio_utils
  juce::juce_audio_processors
  juce::juce_gui_basics
  juce::juce_recommended_config_flags
  juce::juce_recommended_warning_flags)
