'use strict';

// Chromium switches applied before the app is ready. Feature names change between
// Chromium versions and unknown names are ignored silently, so test/e2e.js checks
// the outcome (no AI APIs on pages, no model folders on disk) instead of trusting this list.
const AI_FEATURES = [
  'AIPromptAPI',
  'AIPromptAPIForExtension',
  'AIPromptAPIForWebPlatform',
  'AIRewriterAPI',
  'AISummarizationAPI',
  'AIWriterAPI',
  'AIProofreadingAPI',
  'AILanguageDetectionAPI',
  'LanguageDetectionAPI',
  'TranslationAPI',
  'BuiltInAIAPI',
  'OnDeviceModelService',
  'OptimizationGuideModelDownloading',
  'OptimizationGuideOnDeviceModel',
  'OptimizationGuidePersonalizedFetching',
  'TextSafetyClassifier',
  'DevToolsAiAssistancePerformanceAgent',
  'DevToolsConsoleInsights',
  'DevToolsFreestyler',
];

const BACKGROUND_FEATURES = [
  'InterestFeedContentSuggestions',
  'MediaRouter',
  'Translate',
  'PrivacySandboxSettings4',
  'BrowsingTopics',
  'Fledge',
  'AttributionReporting',
  'FencedFrames',
];

const AI_BLINK_FEATURES = [
  'LanguageModel',
  'AIPromptAPI',
  'AISummarizerAPI',
  'AIWriterAPI',
  'AIRewriterAPI',
  'AIProofreaderAPI',
  'LanguageDetectionAPI',
  'TranslationAPI',
];

function applyFlags(app) {
  const c = app.commandLine;
  // Tests need the window to keep painting even if the display has gone to sleep.
  const forTests = process.env.TERN_TEST ? ['CalculateNativeWinOcclusion'] : [];
  c.appendSwitch('disable-features', [...AI_FEATURES, ...BACKGROUND_FEATURES, ...forTests].join(','));
  c.appendSwitch('disable-blink-features', AI_BLINK_FEATURES.join(','));
  c.appendSwitch('disable-background-networking');
  c.appendSwitch('disable-component-update');
  c.appendSwitch('disable-domain-reliability');
  c.appendSwitch('no-pings');
  c.appendSwitch('disable-breakpad');
}

module.exports = { applyFlags };
