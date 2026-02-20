/**
 * Wingman - FA Real-Time Assistant
 * Frontend: dual audio capture, WebSocket, UI updates for all AI engines.
 *
 * Audio protocol:
 *   Each binary WebSocket message starts with a 1-byte source ID:
 *     0x01 = microphone  (Advisor)
 *     0x02 = system audio (Client via Zoom speakers)
 *   Followed by raw Int16 PCM audio data.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE_MIC = 0x01;
const SOURCE_SPEAKER = 0x02;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let audioContext = null;
let micStream = null;
let speakerStream = null;
let micWorklet = null;
let speakerWorklet = null;
let websocket = null;
let isListening = false;
let hasSpeakerAudio = false;
let pingInterval = null;
let timerInterval = null;
let timerStartTime = null;
let waitingForSummary = false;

// Per-speaker interim elements for interleaved display
const interimElements = {};

// Active suggestion cards
const activeSuggestions = {};

// DOM references
const transcriptContainer = document.getElementById("transcript-content");
const suggestionsContainer = document.getElementById("suggestions-content");
const wordcloudContent = document.getElementById("wordcloud-content");
const complianceToasts = document.getElementById("compliance-toasts");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const deviceSelect = document.getElementById("audio-device");
const systemAudioCheckbox = document.getElementById("capture-system-audio");
const micIndicator = document.getElementById("mic-indicator");
const speakerIndicator = document.getElementById("speaker-indicator");
const meetingTimer = document.getElementById("meeting-timer");
const timerDisplay = document.getElementById("timer-display");
const coachingToggle = document.getElementById("coaching-mode-toggle");
const simulationToggle = document.getElementById("simulation-mode");
const micGroup = document.getElementById("mic-group");
const systemAudioLabel = document.getElementById("system-audio-label");
const intelligenceBar = document.getElementById("intelligence-bar");
const riskGaugeFill = document.getElementById("risk-gauge-fill");
const riskGaugeLabel = document.getElementById("risk-gauge-label");
const sentimentBadge = document.getElementById("sentiment-badge");
const trackerContent = document.getElementById("tracker-content");
const trackerCount = document.getElementById("tracker-count");
const trackerModeSelector = document.getElementById("tracker-mode-selector");
const trackerManualEntry = document.getElementById("tracker-manual-entry");
const trackerAutoWaiting = document.getElementById("tracker-auto-waiting");
const trackerItemsContainer = document.getElementById("tracker-items");
const postCallModal = document.getElementById("post-call-modal");
const modalBody = document.getElementById("modal-body");
const modalFooter = document.getElementById("modal-footer");
const bottomPanelTitle = document.getElementById("bottom-panel-title");
const clientContextBadge = document.getElementById("client-context-badge");

// Store email text for copy
let currentFollowUpEmail = "";
// Store CRM data for copy
let currentCrmData = null;
let currentNextMeetingTopics = [];

// Todo tracking (accumulated for post-call, not shown in real-time panel)
const knownTodoItems = new Set();
const accumulatedTodoItems = [];

// Discussion tracker mode: "none" | "manual" | "auto" | "active"
let trackerSetupMode = "none";
let autoSuggestRequested = false;

// Accumulated client profile data for post-call report (no longer rendered in real-time)
const accumulatedProfile = {
  family: new Set(),
  life_events: new Set(),
  interests: new Set(),
  career: new Set(),
  key_concerns: new Set(),
  referral_opportunities: new Set(),
  ms_product_signals: new Set(),
  document_triggers: new Set(),
};

// Latest sentiment/risk/tier for post-call report
let latestSentiment = "";
let latestSentimentDetail = "";
let latestRiskProfile = "";
let latestRiskDetail = "";
let latestClientTier = "";

// Client context from pre-call prep (loaded from sessionStorage)
let clientContextId = null;
let clientContextName = null;
let discussionPoints = [];
let discussionTrackerMode = false;

// ---------------------------------------------------------------------------
// Audio Device Enumeration
// ---------------------------------------------------------------------------

async function enumerateAudioDevices() {
  try {
    const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    tempStream.getTracks().forEach((t) => t.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter((d) => d.kind === "audioinput");

    deviceSelect.innerHTML = "";
    audioInputs.forEach((device) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label || `Microphone ${deviceSelect.length + 1}`;
      deviceSelect.appendChild(option);
    });
  } catch (err) {
    console.error("Could not enumerate devices:", err);
    setStatus("error", "Microphone access denied");
  }
}

// ---------------------------------------------------------------------------
// Audio Capture — Dual Streams
// ---------------------------------------------------------------------------

async function startAudioCapture() {
  const sources = [];
  const isSimulation = simulationToggle.checked;

  // ── 1. Capture microphone (skip in simulation mode) ──
  if (!isSimulation) {
    const deviceId = deviceSelect.value;
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      },
    });
    sources.push("mic");
  }

  // ── 2. Capture system audio (always in simulation, optional in live) ──
  hasSpeakerAudio = false;
  if (isSimulation || systemAudioCheckbox.checked) {
    try {
      speakerStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      if (speakerStream.getAudioTracks().length === 0) {
        console.warn("No audio track in screen share — check 'Share audio' next time.");
        speakerStream.getTracks().forEach((t) => t.stop());
        speakerStream = null;
      } else {
        hasSpeakerAudio = true;
        sources.push("speaker");

        speakerStream.getAudioTracks()[0].onended = () => {
          hasSpeakerAudio = false;
          updateSourceIndicators();
          console.info("System audio sharing ended by user.");
        };
      }
    } catch (err) {
      console.warn("System audio capture not available:", err.message);
      if (speakerStream) {
        speakerStream.getTracks().forEach((t) => t.stop());
      }
      speakerStream = null;
    }
  }

  // In simulation mode, system audio is required
  if (isSimulation && !hasSpeakerAudio) {
    throw new Error("Simulation mode requires system audio. Please share audio and try again.");
  }

  // ── 3. Set up AudioContext + AudioWorklets ──
  try {
    audioContext = new AudioContext({ sampleRate: 24000 });
  } catch (e) {
    console.warn("Could not create AudioContext at 24kHz, using default:", e);
    audioContext = new AudioContext();
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  const sampleRate = audioContext.sampleRate;
  await audioContext.audioWorklet.addModule("/static/audio-processor.js?v=3");

  // Mic worklet (only in live mode)
  if (!isSimulation && micStream) {
    const micSource = audioContext.createMediaStreamSource(micStream);
    micWorklet = new AudioWorkletNode(audioContext, "audio-capture-processor");
    micWorklet.port.onmessage = (event) => sendAudioPacket(SOURCE_MIC, event.data);
    micSource.connect(micWorklet);
    micWorklet.connect(audioContext.destination);
  }

  // Speaker worklet
  if (hasSpeakerAudio && speakerStream) {
    const audioOnlyStream = new MediaStream(speakerStream.getAudioTracks());
    const speakerSource = audioContext.createMediaStreamSource(audioOnlyStream);
    speakerWorklet = new AudioWorkletNode(audioContext, "audio-capture-processor");
    speakerWorklet.port.onmessage = (event) => sendAudioPacket(SOURCE_SPEAKER, event.data);
    speakerSource.connect(speakerWorklet);
    speakerWorklet.connect(audioContext.destination);
  }

  updateSourceIndicators();
  return { sampleRate, sources, mode: isSimulation ? "simulation" : "live" };
}

function sendAudioPacket(sourceId, pcmArrayBuffer) {
  if (!websocket || websocket.readyState !== WebSocket.OPEN) return;

  const pcm = new Uint8Array(pcmArrayBuffer);
  const packet = new Uint8Array(1 + pcm.length);
  packet[0] = sourceId;
  packet.set(pcm, 1);
  websocket.send(packet.buffer);
}

function stopAudioCapture() {
  if (micWorklet) { micWorklet.disconnect(); micWorklet = null; }
  if (speakerWorklet) { speakerWorklet.disconnect(); speakerWorklet = null; }
  if (audioContext) { audioContext.close(); audioContext = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  if (speakerStream) { speakerStream.getTracks().forEach((t) => t.stop()); speakerStream = null; }
  hasSpeakerAudio = false;
}

// ---------------------------------------------------------------------------
// Source Indicators
// ---------------------------------------------------------------------------

function updateSourceIndicators() {
  if (isListening) {
    micIndicator.className = "source-indicator active";
    speakerIndicator.className = hasSpeakerAudio
      ? "source-indicator active"
      : "source-indicator inactive";
  } else {
    micIndicator.className = "source-indicator inactive";
    speakerIndicator.className = "source-indicator inactive";
  }
}

// ---------------------------------------------------------------------------
// Meeting Timer
// ---------------------------------------------------------------------------

function startMeetingTimer() {
  timerStartTime = Date.now();
  meetingTimer.classList.remove("hidden");
  timerDisplay.textContent = "00:00";
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - timerStartTime) / 1000);
    const mins = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const secs = String(elapsed % 60).padStart(2, "0");
    timerDisplay.textContent = `${mins}:${secs}`;
  }, 1000);
}

function stopMeetingTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

function connectWebSocket(sampleRate, sources, mode) {
  return new Promise((resolve, reject) => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws/audio`;

    websocket = new WebSocket(wsUrl);
    websocket.binaryType = "arraybuffer";

    websocket.onopen = () => {
      websocket.send(JSON.stringify({
        type: "config",
        sampleRate,
        sources,
        mode: mode || "live",
      }));
      // Send client context and discussion points if available
      setTimeout(() => sendClientContext(), 100);
      resolve();
    };

    websocket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      handleServerMessage(data);
    };

    websocket.onerror = (err) => {
      console.error("WebSocket error:", err);
      setStatus("error", "Connection error");
      reject(err);
    };

    websocket.onclose = (event) => {
      console.warn("WebSocket closed:", event.code, event.reason);
      if (waitingForSummary) {
        // Connection closed while waiting for summary — show error in modal
        console.error("[Wingman] WebSocket closed before summary arrived");
        waitingForSummary = false;
        modalBody.innerHTML = `<p style="color: var(--error);">Connection lost before summary could be generated. Close this dialog to continue.</p>`;
        modalFooter.classList.remove("hidden");
        // Stop audio since the connection is gone anyway
        stopAudioCapture();
      } else if (isListening) {
        setStatus("error", "Connection lost");
        finishStop();
      }
    };
  });
}

function startPingInterval() {
  stopPingInterval();
  pingInterval = setInterval(() => {
    if (websocket && websocket.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({ type: "ping" }));
    }
  }, 10000);
}

function stopPingInterval() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

// ---------------------------------------------------------------------------
// Handle Server Messages
// ---------------------------------------------------------------------------

function handleServerMessage(data) {
  switch (data.type) {
    case "transcript":
      handleTranscript(data);
      break;
    case "suggestion_start":
      handleSuggestionStart(data);
      break;
    case "suggestion_chunk":
      handleSuggestionChunk(data);
      break;
    case "suggestion_done":
      handleSuggestionDone(data);
      break;
    case "intelligence_update":
      console.log("[Wingman] intelligence_update received:", data.sentiment, data.risk_profile);
      handleIntelligenceUpdate(data);
      break;
    case "word_cloud_update":
      console.log("[Wingman] word_cloud_update received:", data.topics ? data.topics.length + " topics" : "none");
      handleWordCloudUpdate(data);
      break;
    case "discussion_tracker_update":
      console.log("[Wingman] discussion_tracker_update received");
      handleDiscussionTrackerUpdate(data);
      break;
    case "discussion_suggestions":
      console.log("[Wingman] discussion_suggestions received");
      handleDiscussionSuggestions(data);
      break;
    case "compliance_alert":
      console.log("[Wingman] compliance_alert:", data.severity, data.issue);
      handleComplianceAlert(data);
      break;
    case "todo_update":
      console.log("[Wingman] todo_update received:", data.items ? data.items.length + " items" : "none");
      handleTodoUpdate(data);
      break;
    case "post_call_summary":
      console.log("[Wingman] post_call_summary received");
      handlePostCallSummary(data);
      break;
    case "status":
      setStatus("connected", data.message);
      break;
    case "error":
      console.error("[Wingman] Server error:", data.message);
      setStatus("error", data.message);
      break;
    case "pong":
      break;
  }
}

// ---------------------------------------------------------------------------
// Transcript Rendering
// ---------------------------------------------------------------------------

function removeEmptyState(container) {
  const empty = container.querySelector(".empty-state") || container.querySelector(".empty-state-sm");
  if (empty) empty.remove();
}

function handleTranscript(data) {
  const { text, is_final, speaker } = data;
  removeEmptyState(transcriptContainer);

  const speakerClass = speaker === "Client" ? "speaker-client" : "speaker-advisor";

  if (is_final) {
    if (interimElements[speaker]) {
      interimElements[speaker].remove();
      delete interimElements[speaker];
    }

    const line = document.createElement("div");
    line.className = `transcript-line final ${speakerClass}`;

    const timestamp = document.createElement("span");
    timestamp.className = "transcript-time";
    timestamp.textContent = new Date().toLocaleTimeString();

    const label = document.createElement("span");
    label.className = `speaker-label ${speakerClass}`;
    label.textContent = speaker;

    const content = document.createElement("span");
    content.className = "transcript-text";
    content.textContent = text;

    line.appendChild(timestamp);
    line.appendChild(label);
    line.appendChild(content);
    transcriptContainer.appendChild(line);
    transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
  } else {
    if (!interimElements[speaker]) {
      const line = document.createElement("div");
      line.className = `transcript-line interim ${speakerClass}`;

      const timestamp = document.createElement("span");
      timestamp.className = "transcript-time";
      timestamp.textContent = new Date().toLocaleTimeString();

      const label = document.createElement("span");
      label.className = `speaker-label ${speakerClass}`;
      label.textContent = speaker;

      const content = document.createElement("span");
      content.className = "transcript-text";

      line.appendChild(timestamp);
      line.appendChild(label);
      line.appendChild(content);
      transcriptContainer.appendChild(line);
      interimElements[speaker] = line;
    }

    interimElements[speaker].querySelector(".transcript-text").textContent = text;
    transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
  }
}

// ---------------------------------------------------------------------------
// Suggestion Rendering
// ---------------------------------------------------------------------------

function handleSuggestionStart(data) {
  removeEmptyState(suggestionsContainer);

  const card = document.createElement("div");
  card.className = "suggestion-card appearing";
  card.id = `suggestion-${data.id}`;

  const header = document.createElement("div");
  header.className = "suggestion-header";

  const icon = document.createElement("span");
  icon.className = "suggestion-icon";
  icon.textContent = "\u{1F4A1}";

  const time = document.createElement("span");
  time.className = "suggestion-time";
  time.textContent = new Date().toLocaleTimeString();

  const spinner = document.createElement("span");
  spinner.className = "suggestion-spinner";

  header.appendChild(icon);
  header.appendChild(time);
  header.appendChild(spinner);

  const body = document.createElement("div");
  body.className = "suggestion-body";

  card.appendChild(header);
  card.appendChild(body);

  suggestionsContainer.prepend(card);
  activeSuggestions[data.id] = { card, body };

  requestAnimationFrame(() => {
    card.classList.remove("appearing");
    card.classList.add("visible");
  });
}

function handleSuggestionChunk(data) {
  const entry = activeSuggestions[data.id];
  if (!entry) return;
  entry.body.textContent += data.text;
  suggestionsContainer.scrollTop = 0;
}

function handleSuggestionDone(data) {
  const entry = activeSuggestions[data.id];
  if (!entry) return;

  const spinner = entry.card.querySelector(".suggestion-spinner");
  if (spinner) spinner.remove();

  if (!data.had_suggestion) {
    entry.card.remove();
  } else {
    const rawText = entry.body.textContent;

    // Split coaching mode responses (suggestion + 💡 explanation)
    const coachingSplit = rawText.split("\u{1F4A1}");

    if (coachingSplit.length > 1) {
      const suggestionHtml = coachingSplit[0].trim().replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
      entry.body.innerHTML = suggestionHtml;

      const coachingDiv = document.createElement("div");
      coachingDiv.className = "suggestion-coaching";
      coachingDiv.textContent = "\u{1F4A1} " + coachingSplit[1].trim();
      entry.card.appendChild(coachingDiv);
    } else {
      let html = rawText;
      html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
      entry.body.innerHTML = html;
    }
  }

  delete activeSuggestions[data.id];
}

// ---------------------------------------------------------------------------
// Intelligence Rendering
// ---------------------------------------------------------------------------

const RISK_LEVELS = {
  very_conservative: { width: 10, label: "Very Conservative" },
  conservative:      { width: 25, label: "Conservative" },
  moderate_conservative: { width: 40, label: "Moderate-Conservative" },
  moderate:          { width: 55, label: "Moderate" },
  moderate_aggressive: { width: 72, label: "Moderate-Aggressive" },
  aggressive:        { width: 90, label: "Aggressive" },
};

function handleIntelligenceUpdate(data) {
  console.log("[Wingman] intelligence_update received.",
    "family:", (data.family || []).length,
    "| life_events:", (data.life_events || []).length,
    "| interests:", (data.interests || []).length,
    "| career:", (data.career || []).length,
    "| sentiment:", data.sentiment,
    "| risk:", data.risk_profile
  );

  const hasProfile = ["family", "life_events", "interests", "career"].some(k => data[k] && data[k].length > 0);
  const hasIntel = data.sentiment || data.key_concerns;
  if (!hasProfile && !hasIntel) {
    console.log("[Wingman] Empty intelligence — skipped");
    return;
  }

  // Reveal risk gauge bar
  intelligenceBar.classList.remove("hidden");

  // Update risk gauge (still shown in real-time in the intelligence bar)
  if (data.risk_profile) {
    const riskInfo = RISK_LEVELS[data.risk_profile] || RISK_LEVELS.moderate;
    riskGaugeFill.style.width = riskInfo.width + "%";
    riskGaugeLabel.textContent = riskInfo.label;
    riskGaugeLabel.title = data.risk_detail || "";
    latestRiskProfile = data.risk_profile;
    latestRiskDetail = data.risk_detail || "";
  }

  // Update sentiment badge (now shown in word cloud panel header)
  if (data.sentiment) {
    const s = data.sentiment;
    sentimentBadge.textContent = s.charAt(0).toUpperCase() + s.slice(1);
    sentimentBadge.className = `profile-badge ${s}`;
    sentimentBadge.title = data.sentiment_detail || "";
    latestSentiment = data.sentiment;
    latestSentimentDetail = data.sentiment_detail || "";
  }

  // Accumulate profile data for post-call report (no longer rendered in real-time)
  const profileKeys = ["family", "life_events", "interests", "career", "key_concerns", "referral_opportunities", "ms_product_signals", "document_triggers"];
  for (const key of profileKeys) {
    const items = data[key];
    if (items && items.length > 0) {
      items.forEach(item => accumulatedProfile[key].add(item));
    }
  }

  if (data.client_tier && data.client_tier !== "Unknown") {
    latestClientTier = data.client_tier;
  }
}

// ---------------------------------------------------------------------------
// Word Cloud Rendering
// ---------------------------------------------------------------------------

function handleWordCloudUpdate(data) {
  if (!data.topics || data.topics.length === 0) return;

  removeEmptyState(wordcloudContent);

  // Get or create the cloud container
  let cloud = wordcloudContent.querySelector(".wordcloud-cloud");
  if (!cloud) {
    cloud = document.createElement("div");
    cloud.className = "wordcloud-cloud";
    wordcloudContent.appendChild(cloud);
  }

  // Build map of new topics
  const newTopics = new Map();
  for (const topic of data.topics) {
    newTopics.set(topic.text.toLowerCase(), topic);
  }

  // Update existing words, track which to keep
  const existingWords = cloud.querySelectorAll(".wordcloud-word");
  const existingKeys = new Set();

  existingWords.forEach(wordEl => {
    const key = wordEl.dataset.topic;
    if (newTopics.has(key)) {
      const topic = newTopics.get(key);
      wordEl.style.fontSize = `${mapWeightToSize(topic.weight)}px`;
      wordEl.style.opacity = mapWeightToOpacity(topic.weight);
      wordEl.className = `wordcloud-word tone-${topic.tone}`;
      wordEl.title = `${topic.tone} · emphasis ${topic.weight}/10`;
      existingKeys.add(key);
    } else {
      wordEl.style.opacity = "0";
      wordEl.style.transform = "scale(0.5)";
      setTimeout(() => wordEl.remove(), 400);
    }
  });

  // Add new words — interleave by weight for a natural cloud layout
  const sortedTopics = [...data.topics].sort((a, b) => b.weight - a.weight);
  const interleaved = [];
  let lo = 0, hi = sortedTopics.length - 1;
  while (lo <= hi) {
    interleaved.push(sortedTopics[lo++]);
    if (lo <= hi) interleaved.push(sortedTopics[hi--]);
  }

  for (const topic of interleaved) {
    const key = topic.text.toLowerCase();
    if (existingKeys.has(key)) continue;

    const word = document.createElement("span");
    word.className = `wordcloud-word tone-${topic.tone} wc-new`;
    word.dataset.topic = key;
    word.textContent = topic.text;
    word.style.fontSize = `${mapWeightToSize(topic.weight)}px`;
    word.style.opacity = mapWeightToOpacity(topic.weight);
    word.title = `${topic.tone} · emphasis ${topic.weight}/10`;

    // Insert near middle for natural cloud appearance
    const children = cloud.children;
    if (children.length > 0) {
      const midIndex = Math.floor(children.length / 2);
      cloud.insertBefore(word, children[midIndex]);
    } else {
      cloud.appendChild(word);
    }

    setTimeout(() => word.classList.remove("wc-new"), 600);
  }
}

function mapWeightToSize(weight) {
  const minSize = 11;
  const maxSize = 38;
  return Math.round(minSize + ((weight - 1) / 9) * (maxSize - minSize));
}

function mapWeightToOpacity(weight) {
  if (weight >= 8) return "1";
  if (weight >= 5) return "0.85";
  if (weight >= 3) return "0.7";
  return "0.55";
}

// ---------------------------------------------------------------------------
// Compliance Toast Rendering
// ---------------------------------------------------------------------------

function handleComplianceAlert(data) {
  const toast = document.createElement("div");
  toast.className = `compliance-toast ${data.severity || "warning"}`;

  const header = document.createElement("div");
  header.className = "compliance-toast-header";

  const icon = document.createElement("span");
  icon.textContent = data.severity === "critical" ? "\u{1F6A8}" : "\u{26A0}\u{FE0F}";

  const severity = document.createElement("span");
  severity.className = "compliance-severity";
  severity.textContent = (data.severity || "warning").toUpperCase();

  const closeBtn = document.createElement("button");
  closeBtn.className = "compliance-toast-close";
  closeBtn.textContent = "\u00D7";
  closeBtn.onclick = () => dismissToast(toast);

  header.appendChild(icon);
  header.appendChild(severity);
  header.appendChild(closeBtn);

  const issue = document.createElement("div");
  issue.className = "compliance-issue";
  issue.textContent = data.issue || "";

  toast.appendChild(header);
  toast.appendChild(issue);

  if (data.recommendation) {
    const rec = document.createElement("div");
    rec.className = "compliance-recommendation";
    rec.textContent = "\u{1F4A1} " + data.recommendation;
    toast.appendChild(rec);
  }

  complianceToasts.prepend(toast);

  // Auto-dismiss after 12 seconds
  setTimeout(() => dismissToast(toast), 12000);
}

function dismissToast(toast) {
  if (!toast.parentNode) return;
  toast.style.animation = "fadeOut 0.3s ease-out forwards";
  setTimeout(() => toast.remove(), 300);
}

// ---------------------------------------------------------------------------
// To-Do Accumulation (displayed in post-call modal, not in real-time panel)
// ---------------------------------------------------------------------------

function handleTodoUpdate(data) {
  if (!data.items || data.items.length === 0) return;

  const newItems = data.items.filter(item => !knownTodoItems.has(item));
  if (newItems.length === 0) return;

  for (const item of newItems) {
    knownTodoItems.add(item);
    accumulatedTodoItems.push({
      text: item,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    });
  }
  console.log(`[Wingman] ${newItems.length} new action items accumulated (total: ${accumulatedTodoItems.length})`);
}

// ---------------------------------------------------------------------------
// Post-Call Summary Modal
// ---------------------------------------------------------------------------

function handlePostCallSummary(data) {
  console.log("[Wingman] post_call_summary received, keys:", Object.keys(data));
  waitingForSummary = false;
  if (summaryTimeout) { clearTimeout(summaryTimeout); summaryTimeout = null; }

  if (data.error) {
    modalBody.innerHTML = `<p style="color: var(--error); padding: 20px;">Error: ${data.error}</p>`;
    modalFooter.classList.remove("hidden");
    return;
  }

  currentFollowUpEmail = data.follow_up_email || "";
  currentCrmData = data.crm_activity_log || null;
  currentNextMeetingTopics = data.next_meeting_topics || [];

  // Build tabbed content — priority order for FA workflow
  const tabs = [];

  // 1. Summary (always first)
  if (data.summary) {
    let content = `<p class="modal-summary-text">${escapeHtml(data.summary).replace(/\n/g, "<br>")}</p>`;
    if (data.client_insights && data.client_insights.length > 0) {
      content += `<div class="modal-subsection">
        <div class="modal-section-title">\u{1F4A1} Key Insights</div>
        <ul class="modal-list">${data.client_insights.map(i => `<li>${escapeHtml(i)}</li>`).join("")}</ul>
      </div>`;
    }
    tabs.push({ id: "summary", label: "Summary", icon: "\u{1F4CB}", content });
  }

  // 2. CRM Export (auto-fill)
  if (data.crm_activity_log) {
    const crm = data.crm_activity_log;
    const meetingDate = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const meetingDuration = timerDisplay ? timerDisplay.textContent : "--:--";
    const clientName = clientContextName || "—";

    const crmContent = `
      <div class="crm-export">
        <div class="crm-section">
          <div class="crm-section-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg>
            Activity Details
          </div>
          <div class="crm-fields">
            <div class="crm-row">
              <div class="crm-field"><span class="crm-label">Activity Type</span><span class="crm-value">${escapeHtml(crm.activity_type || "Client Review")}</span></div>
              <div class="crm-field"><span class="crm-label">Contact Method</span><span class="crm-value">${escapeHtml(crm.contact_method || "Video Call")}</span></div>
            </div>
            <div class="crm-row">
              <div class="crm-field"><span class="crm-label">Date</span><span class="crm-value">${meetingDate}</span></div>
              <div class="crm-field"><span class="crm-label">Duration</span><span class="crm-value">${meetingDuration}</span></div>
            </div>
            <div class="crm-row">
              <div class="crm-field"><span class="crm-label">Client</span><span class="crm-value">${escapeHtml(clientName)}</span></div>
              <div class="crm-field"><span class="crm-label">Attendees</span><span class="crm-value">${escapeHtml(crm.attendees || "FA, Client")}</span></div>
            </div>
            <div class="crm-row crm-row-full">
              <div class="crm-field"><span class="crm-label">Meeting Purpose</span><span class="crm-value">${escapeHtml(crm.meeting_purpose || "—")}</span></div>
            </div>
          </div>
        </div>
        <div class="crm-section">
          <div class="crm-section-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
            Discussion Details
          </div>
          <div class="crm-fields">
            <div class="crm-row crm-row-full">
              <div class="crm-field"><span class="crm-label">Accounts Discussed</span>
                <div class="crm-tags">${(crm.accounts_discussed || []).map(a => `<span class="crm-tag">${escapeHtml(a)}</span>`).join("") || '<span class="crm-empty">None specified</span>'}</div>
              </div>
            </div>
            <div class="crm-row crm-row-full">
              <div class="crm-field"><span class="crm-label">Products &amp; Services Discussed</span>
                <div class="crm-tags">${(crm.products_discussed || []).map(p => `<span class="crm-tag crm-tag-product">${escapeHtml(p)}</span>`).join("") || '<span class="crm-empty">None specified</span>'}</div>
              </div>
            </div>
            <div class="crm-row crm-row-full">
              <div class="crm-field"><span class="crm-label">Assets In Motion</span><span class="crm-value">${escapeHtml(crm.assets_in_motion || "None discussed")}</span></div>
            </div>
            <div class="crm-row">
              <div class="crm-field"><span class="crm-label">Client Sentiment</span><span class="crm-value crm-sentiment crm-sentiment-${crm.client_sentiment || "neutral"}">${escapeHtml((crm.client_sentiment || "neutral").charAt(0).toUpperCase() + (crm.client_sentiment || "neutral").slice(1))}</span></div>
              <div class="crm-field"><span class="crm-label">Referral / Specialist</span><span class="crm-value">${escapeHtml(crm.referral_opportunities || "None identified")}</span></div>
            </div>
          </div>
        </div>
        <div class="crm-section">
          <div class="crm-section-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            Compliance &amp; Suitability
          </div>
          <div class="crm-fields">
            <div class="crm-row">
              <div class="crm-field"><span class="crm-label">Risk Profile Confirmed</span><span class="crm-value">${crm.risk_profile_confirmed ? '<span class="crm-check-yes">Yes</span>' : '<span class="crm-check-no">No</span>'}</span></div>
              <div class="crm-field"><span class="crm-label">Disclosure Notes</span><span class="crm-value">${escapeHtml(crm.disclosure_notes || "No new disclosures required")}</span></div>
            </div>
            <div class="crm-row crm-row-full">
              <div class="crm-field"><span class="crm-label">Suitability Assessment</span><span class="crm-value">${escapeHtml(crm.suitability_notes || "—")}</span></div>
            </div>
          </div>
        </div>
        <div class="crm-section">
          <div class="crm-section-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            Follow-Up
          </div>
          <div class="crm-fields">
            <div class="crm-row">
              <div class="crm-field"><span class="crm-label">Next Contact Date</span><span class="crm-value">${escapeHtml(crm.next_contact_date || "—")}</span></div>
              <div class="crm-field"><span class="crm-label">Next Contact Type</span><span class="crm-value">${escapeHtml(crm.next_contact_type || "Follow-Up Call")}</span></div>
            </div>
            <div class="crm-row crm-row-full">
              <div class="crm-field">
                <button class="btn calendar-download-btn" onclick="downloadCalendarInvite()">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg>
                  Download Calendar Invite (.ics)
                </button>
                <span class="calendar-hint">Opens in Outlook, Google Calendar, or Apple Calendar</span>
              </div>
            </div>
          </div>
        </div>
        <div class="crm-actions">
          <button class="btn btn-copy crm-copy-btn" onclick="copyCrmExport()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Copy CRM Entry
          </button>
          <span class="crm-copy-hint">Paste directly into Salesforce / 3D CRM activity log</span>
        </div>
      </div>`;
    tabs.push({ id: "crm", label: "CRM Export", icon: "\u{1F4C4}", content: crmContent });
  }

  // 3. Action Items (post-call only — what the FA needs to do)
  if (data.action_items && data.action_items.length > 0) {
    const actionItemsContent = `<div class="modal-subsection">
      <ul class="modal-checklist">${data.action_items.map(i => `<li><span class="check-icon"></span>${escapeHtml(i)}</li>`).join("")}</ul>
    </div>`;
    tabs.push({ id: "actionitems", label: "Action Items", icon: "\u{2705}", content: actionItemsContent });
  }

  // 4. Client Profile
  const profileContent = buildClientProfileContent();
  if (profileContent) {
    tabs.push({ id: "profile", label: "Profile", icon: "\u{1F464}", content: profileContent });
  }

  // 5. Follow-Up Email
  if (data.follow_up_email) {
    const emailContent = `
      <div class="modal-email-box">${escapeHtml(data.follow_up_email)}</div>
      <button class="btn btn-copy modal-tab-copy" onclick="copyFollowUpEmail()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
        Copy Email
      </button>`;
    tabs.push({ id: "email", label: "Follow-Up Email", icon: "\u{2709}\u{FE0F}", content: emailContent });
  }

  // 6. Next Steps
  if (data.next_meeting_topics && data.next_meeting_topics.length > 0) {
    const nextStepsContent = `<div class="modal-subsection">
      <div class="modal-section-title">\u{1F4C5} Suggested Agenda for Next Review</div>
      <ul class="modal-list">${data.next_meeting_topics.map(i => `<li>${escapeHtml(i)}</li>`).join("")}</ul>
    </div>`;
    tabs.push({ id: "nextsteps", label: "Next Steps", icon: "\u{1F4C5}", content: nextStepsContent });
  }

  // 7. Compliance Notes
  if (data.compliance_notes && data.compliance_notes.length > 0) {
    const complianceContent = `<div class="modal-subsection">
      <div class="modal-section-title">\u{1F6E1}\u{FE0F} Reg BI Compliance Documentation</div>
      <ul class="modal-list">${data.compliance_notes.map(n => `<li>${escapeHtml(n)}</li>`).join("")}</ul>
      <p class="modal-compliance-note">Auto-generated for Reg BI documentation. Review before CRM entry.</p>
    </div>`;
    tabs.push({ id: "compliance", label: "Compliance", icon: "\u{1F6E1}\u{FE0F}", content: complianceContent });
  }

  // 8. FA Notes (always present)
  const faNotesContent = `
    <div class="fa-notes-section">
      <div class="fa-notes-header">
        <div class="fa-notes-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
          Personal Notes
        </div>
        <span class="fa-notes-hint">Private notes for your next review with this client</span>
      </div>
      <textarea class="fa-notes-textarea" id="fa-notes-textarea" placeholder="Add your personal notes here...\n\nExamples:\n- Client seemed hesitant about risk; revisit allocation next call\n- Spouse mentioned daughter's wedding in June — good rapport topic\n- Bring up SBL refinance option once rates drop\n- Client prefers morning calls (before 10am ET)"></textarea>
      <div class="fa-notes-actions">
        <button class="btn fa-notes-copy-btn" onclick="copyFaNotes()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
          Copy Notes
        </button>
        <button class="btn fa-notes-save-btn" onclick="saveFaNotes()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
            <polyline points="17 21 17 13 7 13 7 21"/>
            <polyline points="7 3 7 8 15 8"/>
          </svg>
          Save to Browser
        </button>
        <span class="fa-notes-save-status" id="fa-notes-save-status"></span>
      </div>
    </div>`;
  tabs.push({ id: "fanotes", label: "FA Notes", icon: "\u{270F}\u{FE0F}", content: faNotesContent });

  // Render the tabbed UI
  if (tabs.length === 0) {
    modalBody.innerHTML = `<p style="color: var(--text-muted); padding: 20px;">No summary data available.</p>`;
    modalFooter.classList.remove("hidden");
    return;
  }

  let tabBarHtml = `<div class="modal-tab-bar">`;
  for (let i = 0; i < tabs.length; i++) {
    const active = i === 0 ? " active" : "";
    tabBarHtml += `<button class="modal-tab-btn${active}" data-tab="${tabs[i].id}">${tabs[i].icon} ${tabs[i].label}</button>`;
  }
  tabBarHtml += `</div>`;

  let tabContentHtml = "";
  for (let i = 0; i < tabs.length; i++) {
    const active = i === 0 ? " active" : "";
    tabContentHtml += `<div class="modal-tab-content${active}" data-tab-content="${tabs[i].id}">${tabs[i].content}</div>`;
  }

  modalBody.innerHTML = tabBarHtml + `<div class="modal-tab-panels">${tabContentHtml}</div>`;

  // Wire up tab switching
  modalBody.querySelectorAll(".modal-tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      modalBody.querySelectorAll(".modal-tab-btn").forEach(b => b.classList.remove("active"));
      modalBody.querySelectorAll(".modal-tab-content").forEach(c => c.classList.remove("active"));
      btn.classList.add("active");
      modalBody.querySelector(`[data-tab-content="${btn.dataset.tab}"]`).classList.add("active");
    });
  });

  modalFooter.classList.remove("hidden");

  // Load previously saved FA notes for this client
  setTimeout(() => loadFaNotesForClient(), 50);
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function buildClientProfileContent() {
  const profileCategories = [
    { key: "family",                 icon: "\u{1F468}\u200D\u{1F469}\u200D\u{1F466}", label: "Family" },
    { key: "life_events",            icon: "\u{1F4C5}", label: "Life Events" },
    { key: "interests",              icon: "\u{2B50}",  label: "Interests" },
    { key: "career",                 icon: "\u{1F4BC}", label: "Career" },
    { key: "key_concerns",           icon: "\u{26A0}\u{FE0F}", label: "Key Concerns" },
    { key: "referral_opportunities", icon: "\u{1F517}", label: "Referral Opportunities" },
    { key: "ms_product_signals",     icon: "\u{1F3E6}", label: "MS Product Opportunities" },
    { key: "document_triggers",      icon: "\u{1F4CB}", label: "Document Triggers" },
  ];

  const hasData = Object.values(accumulatedProfile).some(s => s.size > 0)
    || latestSentiment || latestRiskProfile;

  if (!hasData) return null;

  let html = "";

  // Client Tier + Sentiment + Risk as a compact header row
  if (latestClientTier || latestSentiment || latestRiskProfile) {
    html += `<div class="modal-profile-badges">`;
    if (latestClientTier) {
      html += `<div class="modal-profile-stat">
        <span class="modal-profile-stat-label">Client Segment</span>
        <span class="modal-profile-stat-value">${escapeHtml(latestClientTier)}</span>
      </div>`;
    }
    if (latestSentiment) {
      const s = latestSentiment;
      const detail = latestSentimentDetail ? escapeHtml(latestSentimentDetail) : "";
      html += `<div class="modal-profile-stat">
        <span class="modal-profile-stat-label">Sentiment</span>
        <span class="profile-badge ${s}">${escapeHtml(s.charAt(0).toUpperCase() + s.slice(1))}</span>
        ${detail ? `<span class="modal-profile-stat-detail">${detail}</span>` : ""}
      </div>`;
    }
    if (latestRiskProfile) {
      const riskInfo = RISK_LEVELS[latestRiskProfile] || { label: latestRiskProfile };
      const detail = latestRiskDetail ? escapeHtml(latestRiskDetail) : "";
      html += `<div class="modal-profile-stat">
        <span class="modal-profile-stat-label">Risk Profile</span>
        <span class="modal-profile-stat-value">${escapeHtml(riskInfo.label)}</span>
        ${detail ? `<span class="modal-profile-stat-detail">${detail}</span>` : ""}
      </div>`;
    }
    html += `</div>`;
  }

  // Profile categories in a clean grid
  html += `<div class="modal-profile-grid">`;
  for (const { key, icon, label } of profileCategories) {
    const items = [...accumulatedProfile[key]];
    if (items.length === 0) continue;
    html += `<div class="modal-profile-category">
      <div class="modal-profile-cat-label">${icon} ${escapeHtml(label)}</div>
      <ul class="modal-list">${items.map(i => `<li>${escapeHtml(i)}</li>`).join("")}</ul>
    </div>`;
  }
  html += `</div>`;

  return html;
}

function showPostCallModal() {
  postCallModal.classList.remove("hidden");
  modalBody.innerHTML = `
    <div class="modal-loading">
      <div class="modal-spinner"></div>
      <p>Generating post-call intelligence report...</p>
    </div>`;
  modalFooter.classList.add("hidden");
}

function closePostCallModal() {
  postCallModal.classList.add("hidden");
  finishStop();
}

function copyFollowUpEmail() {
  if (!currentFollowUpEmail) return;
  navigator.clipboard.writeText(currentFollowUpEmail).then(() => {
    const btn = document.querySelector(".modal-tab-copy");
    if (btn) {
      btn.textContent = "Copied!";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy Email`;
        btn.classList.remove("copied");
      }, 2000);
    }
  });
}

function copyCrmExport() {
  if (!currentCrmData) return;
  const crm = currentCrmData;
  const meetingDate = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const meetingDuration = timerDisplay ? timerDisplay.textContent : "--:--";
  const clientName = clientContextName || "—";

  const text = [
    "═══════════════════════════════════════════════",
    "  MORGAN STANLEY — CLIENT ACTIVITY LOG",
    "═══════════════════════════════════════════════",
    "",
    "ACTIVITY DETAILS",
    `  Activity Type:      ${crm.activity_type || "Client Review"}`,
    `  Contact Method:     ${crm.contact_method || "Video Call"}`,
    `  Date:               ${meetingDate}`,
    `  Duration:           ${meetingDuration}`,
    `  Client:             ${clientName}`,
    `  Attendees:          ${crm.attendees || "FA, Client"}`,
    `  Meeting Purpose:    ${crm.meeting_purpose || "—"}`,
    "",
    "DISCUSSION DETAILS",
    `  Accounts Discussed: ${(crm.accounts_discussed || []).join(", ") || "None specified"}`,
    `  Products Discussed: ${(crm.products_discussed || []).join(", ") || "None specified"}`,
    `  Assets In Motion:   ${crm.assets_in_motion || "None discussed"}`,
    `  Client Sentiment:   ${(crm.client_sentiment || "neutral").charAt(0).toUpperCase() + (crm.client_sentiment || "neutral").slice(1)}`,
    `  Referral/Specialist:${crm.referral_opportunities || "None identified"}`,
    "",
    "COMPLIANCE & SUITABILITY",
    `  Risk Profile Confirmed:  ${crm.risk_profile_confirmed ? "Yes" : "No"}`,
    `  Suitability Assessment:  ${crm.suitability_notes || "—"}`,
    `  Disclosure Notes:        ${crm.disclosure_notes || "No new disclosures required"}`,
    "",
    "FOLLOW-UP",
    `  Next Contact Date:  ${crm.next_contact_date || "—"}`,
    `  Next Contact Type:  ${crm.next_contact_type || "Follow-Up Call"}`,
    "",
    "═══════════════════════════════════════════════",
    "  Auto-generated by Wingman | Review before submission",
    "═══════════════════════════════════════════════",
  ].join("\n");

  navigator.clipboard.writeText(text).then(() => {
    const btn = document.querySelector(".crm-copy-btn");
    if (btn) {
      btn.textContent = "Copied!";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy CRM Entry`;
        btn.classList.remove("copied");
      }, 2000);
    }
  });
}

// ---------------------------------------------------------------------------
// FA Notes (F7) + Calendar Invite (F4)
// ---------------------------------------------------------------------------

function copyFaNotes() {
  const textarea = document.getElementById("fa-notes-textarea");
  if (!textarea || !textarea.value.trim()) return;
  navigator.clipboard.writeText(textarea.value).then(() => {
    const btn = document.querySelector(".fa-notes-copy-btn");
    if (btn) {
      btn.textContent = "Copied!";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy Notes`;
        btn.classList.remove("copied");
      }, 2000);
    }
  });
}

function saveFaNotes() {
  const textarea = document.getElementById("fa-notes-textarea");
  const status = document.getElementById("fa-notes-save-status");
  if (!textarea) return;

  const key = clientContextId
    ? `wingman_fa_notes_${clientContextId}`
    : "wingman_fa_notes_general";
  const entry = {
    notes: textarea.value,
    date: new Date().toISOString(),
    client: clientContextName || "General",
  };
  localStorage.setItem(key, JSON.stringify(entry));

  if (status) {
    status.textContent = "Saved!";
    status.classList.add("visible");
    setTimeout(() => { status.textContent = ""; status.classList.remove("visible"); }, 2000);
  }
}

function loadFaNotesForClient() {
  const key = clientContextId
    ? `wingman_fa_notes_${clientContextId}`
    : "wingman_fa_notes_general";
  const raw = localStorage.getItem(key);
  if (!raw) return;
  try {
    const entry = JSON.parse(raw);
    const textarea = document.getElementById("fa-notes-textarea");
    if (textarea && entry.notes) {
      textarea.value = entry.notes;
      textarea.placeholder = "";
    }
  } catch { /* ignore parse errors */ }
}

function downloadCalendarInvite() {
  if (!currentCrmData) return;
  const crm = currentCrmData;
  const clientName = clientContextName || "Client";
  const contactType = crm.next_contact_type || "Follow-Up Call";
  const purpose = crm.meeting_purpose || "Client Review Follow-Up";

  let startDate;
  if (crm.next_contact_date && /^\d{4}-\d{2}-\d{2}$/.test(crm.next_contact_date)) {
    startDate = new Date(crm.next_contact_date + "T10:00:00");
  } else {
    startDate = new Date();
    startDate.setDate(startDate.getDate() + 14);
    startDate.setHours(10, 0, 0, 0);
  }
  const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);

  const fmt = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const uid = `wingman-${Date.now()}@morganstanley.com`;

  const nextTopics = currentNextMeetingTopics || [];

  let description = `${contactType} — ${purpose}\\n\\nGenerated by Wingman`;
  if (nextTopics.length > 0) {
    description += "\\n\\nSuggested Agenda:\\n" + nextTopics.map((t, i) => `${i + 1}. ${t}`).join("\\n");
  }

  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Wingman//Morgan Stanley//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `DTSTART:${fmt(startDate)}`,
    `DTEND:${fmt(endDate)}`,
    `SUMMARY:Morgan Stanley — ${contactType}: ${clientName}`,
    `DESCRIPTION:${description}`,
    `UID:${uid}`,
    `ORGANIZER;CN=Financial Advisor:mailto:fa@morganstanley.com`,
    "STATUS:CONFIRMED",
    "BEGIN:VALARM",
    "TRIGGER:-PT15M",
    "ACTION:DISPLAY",
    "DESCRIPTION:Reminder",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `MS_FollowUp_${clientName.replace(/[^a-zA-Z0-9]/g, "_")}.ics`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  const btn = document.querySelector(".calendar-download-btn");
  if (btn) {
    const original = btn.innerHTML;
    btn.textContent = "Downloaded!";
    btn.classList.add("copied");
    setTimeout(() => { btn.innerHTML = original; btn.classList.remove("copied"); }, 2000);
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function setStatus(state, message) {
  statusDot.className = `status-dot ${state}`;
  statusText.textContent = message || "";
}

// ---------------------------------------------------------------------------
// Start / Stop
// ---------------------------------------------------------------------------

async function startListening() {
  if (isListening) return;

  try {
    setStatus("connecting", "Starting...");
    startBtn.disabled = true;

    const { sampleRate, sources, mode } = await startAudioCapture();
    await connectWebSocket(sampleRate, sources, mode);

    isListening = true;
    startBtn.classList.add("hidden");
    stopBtn.classList.remove("hidden");
    startPingInterval();
    startMeetingTimer();
    updateSourceIndicators();

    // Send coaching mode state
    if (coachingToggle.checked) {
      websocket.send(JSON.stringify({ type: "coaching_mode", enabled: true }));
    }

    let desc;
    if (simulationToggle.checked) {
      desc = "Simulation Mode \u2014 System Audio";
    } else {
      desc = hasSpeakerAudio
        ? "Listening \u2014 Mic + System Audio"
        : "Listening \u2014 Mic only";
    }
    setStatus("connected", desc);
  } catch (err) {
    console.error("Failed to start:", err);
    setStatus("error", err.message || "Failed to start");
    stopAudioCapture();
    startBtn.disabled = false;
  }
}

let summaryTimeout = null;

function stopListening() {
  if (!isListening) return;
  isListening = false;
  stopPingInterval();
  stopMeetingTimer();

  // Send summary request while WebSocket AND audio are still alive.
  // Do NOT stop audio here — stopping the screen share kills the WebSocket
  // before the summary message can reach the server.
  if (websocket && websocket.readyState === WebSocket.OPEN) {
    waitingForSummary = true;
    console.log("[Wingman] Sending generate_summary request, ws readyState:", websocket.readyState);
    websocket.send(JSON.stringify({ type: "generate_summary" }));
    showPostCallModal();
    setStatus("connected", "Generating summary...");

    // Safety timeout: if summary doesn't arrive in 30 seconds, show error
    summaryTimeout = setTimeout(() => {
      if (waitingForSummary) {
        console.error("[Wingman] Summary timed out after 30 seconds");
        waitingForSummary = false;
        modalBody.innerHTML = `<p style="color: var(--error);">Summary generation timed out. The server may still be processing. Close this dialog to continue.</p>`;
        modalFooter.classList.remove("hidden");
      }
    }, 30000);
  } else {
    console.warn("[Wingman] WebSocket not open when stop pressed, readyState:", websocket ? websocket.readyState : "null");
    stopAudioCapture();
    finishStop();
  }
}

function finishStop() {
  // Stop audio capture first (this may close the screen share)
  stopAudioCapture();

  // Then close WebSocket
  if (websocket) {
    websocket.close();
    websocket = null;
  }
  waitingForSummary = false;
  stopBtn.classList.add("hidden");
  startBtn.classList.remove("hidden");
  startBtn.disabled = false;
  updateSourceIndicators();
  meetingTimer.classList.add("hidden");
  setStatus("idle", "Stopped");
}

function clearAll() {
  transcriptContainer.innerHTML = `
    <div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
        <line x1="12" y1="19" x2="12" y2="23"/>
        <line x1="8" y1="23" x2="16" y2="23"/>
      </svg>
      <p>Transcript will appear here once you start listening</p>
    </div>`;

  suggestionsContainer.innerHTML = `
    <div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
        <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>
      </svg>
      <p>AI suggestions will appear here based on the conversation</p>
    </div>`;

  // Clear word cloud
  wordcloudContent.innerHTML = `
    <div class="empty-state">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.2">
        <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>
      </svg>
      <p>Client focus topics will appear as the conversation progresses</p>
    </div>`;

  // Clear accumulated profile data
  for (const key of Object.keys(accumulatedProfile)) {
    accumulatedProfile[key].clear();
  }
  latestSentiment = "";
  latestSentimentDetail = "";
  latestRiskProfile = "";
  latestRiskDetail = "";
  latestClientTier = "";

  // Hide intelligence bar + reset values
  intelligenceBar.classList.add("hidden");
  riskGaugeFill.style.width = "50%";
  riskGaugeLabel.textContent = "--";
  sentimentBadge.textContent = "--";
  sentimentBadge.className = "profile-badge";

  // Clear compliance toasts
  complianceToasts.innerHTML = "";

  // Clear accumulated action items
  knownTodoItems.clear();
  accumulatedTodoItems.length = 0;

  // Reset discussion tracker to mode selector
  discussionPoints = [];
  discussionTrackerMode = false;
  trackerSetupMode = "none";
  autoSuggestRequested = false;
  trackerModeSelector.classList.remove("hidden");
  trackerManualEntry.classList.add("hidden");
  trackerAutoWaiting.classList.add("hidden");
  trackerItemsContainer.classList.add("hidden");
  trackerItemsContainer.innerHTML = "";
  trackerCount.textContent = "0";
  // Clear manual entry inputs
  trackerManualEntry.querySelectorAll(".tracker-input").forEach(inp => { inp.value = ""; });

  // Reset client context
  clientContextId = null;
  clientContextName = null;
  if (clientContextBadge) clientContextBadge.classList.add("hidden");

  // Reset interim tracking
  for (const key of Object.keys(interimElements)) {
    delete interimElements[key];
  }
}

// ---------------------------------------------------------------------------
// Client Context & Discussion Tracker
// ---------------------------------------------------------------------------

function loadClientContext() {
  const params = new URLSearchParams(window.location.search);
  const clientId = params.get("client");

  if (clientId) {
    clientContextId = sessionStorage.getItem("wingman_client_id") || clientId;
    clientContextName = sessionStorage.getItem("wingman_client_name") || clientId;
    const pointsRaw = sessionStorage.getItem("wingman_discussion_points");
    discussionPoints = pointsRaw ? JSON.parse(pointsRaw) : [];

    if (clientContextBadge) {
      clientContextBadge.textContent = clientContextName;
      clientContextBadge.classList.remove("hidden");
    }

    console.log(`[Wingman] Client context loaded: ${clientContextName} (${clientContextId}) with ${discussionPoints.length} discussion points`);
  }

  // If we have discussion points from prep page, activate the tracker immediately
  if (discussionPoints.length > 0) {
    activateTrackerWithPoints(discussionPoints);
  }
  // Otherwise, show the mode selector (default state in HTML)
}

function sendClientContext() {
  if (!websocket || websocket.readyState !== WebSocket.OPEN) return;

  if (clientContextId) {
    websocket.send(JSON.stringify({
      type: "client_context",
      client_id: clientContextId,
      discussion_points: discussionPoints,
    }));
    console.log(`[Wingman] Client context sent to server: ${clientContextId}`);
  } else if (discussionPoints.length > 0) {
    websocket.send(JSON.stringify({
      type: "set_discussion_points",
      discussion_points: discussionPoints,
    }));
    console.log(`[Wingman] Discussion points sent to server (no client context)`);
  }
}

function activateTrackerWithPoints(points) {
  discussionPoints = points;
  discussionTrackerMode = true;
  trackerSetupMode = "active";

  // Hide mode selector and manual entry, show tracker items
  trackerModeSelector.classList.add("hidden");
  trackerManualEntry.classList.add("hidden");
  trackerAutoWaiting.classList.add("hidden");
  trackerItemsContainer.classList.remove("hidden");

  trackerCount.textContent = points.length;
  renderDiscussionTracker(points.map(p => ({ text: p, status: "pending", note: "" })), "");

  // If already connected, send points to server
  if (websocket && websocket.readyState === WebSocket.OPEN) {
    if (clientContextId) {
      websocket.send(JSON.stringify({
        type: "client_context",
        client_id: clientContextId,
        discussion_points: discussionPoints,
      }));
    } else {
      websocket.send(JSON.stringify({
        type: "set_discussion_points",
        discussion_points: discussionPoints,
      }));
    }
  }
}

function showManualEntry() {
  trackerSetupMode = "manual";
  trackerModeSelector.classList.add("hidden");
  trackerManualEntry.classList.remove("hidden");
  trackerAutoWaiting.classList.add("hidden");
  trackerItemsContainer.classList.add("hidden");
  // Focus the first input
  const firstInput = trackerManualEntry.querySelector(".tracker-input");
  if (firstInput) firstInput.focus();
}

function confirmManualPoints() {
  const inputs = trackerManualEntry.querySelectorAll(".tracker-input");
  const points = [];
  inputs.forEach(inp => {
    const val = inp.value.trim();
    if (val) points.push(val);
  });

  if (points.length === 0) return;
  activateTrackerWithPoints(points);
}

async function showAutoSuggest() {
  trackerSetupMode = "auto";
  autoSuggestRequested = true;
  trackerModeSelector.classList.add("hidden");
  trackerManualEntry.classList.add("hidden");
  trackerAutoWaiting.classList.remove("hidden");
  trackerItemsContainer.classList.add("hidden");

  // Show loading state
  const autoText = document.getElementById("tracker-auto-text");
  autoText.textContent = clientContextName
    ? `Generating discussion points for ${clientContextName}...`
    : "Generating discussion point suggestions...";

  // Fetch suggestions immediately via REST API (no WebSocket needed)
  try {
    const res = await fetch("/api/suggest-discussion-points", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientContextId || "" }),
    });
    const data = await res.json();

    if (data.points && data.points.length > 0) {
      activateTrackerWithPoints(data.points);
    } else {
      autoText.textContent = "Could not generate suggestions. Try entering topics manually.";
    }
  } catch (err) {
    console.error("[Wingman] Failed to fetch discussion suggestions:", err);
    autoText.textContent = "Failed to reach server. Try entering topics manually.";
  }
}

function renderDiscussionTracker(points, nudge) {
  if (!points || points.length === 0) return;

  const statusIcons = {
    pending: `<span class="tracker-status tracker-pending" title="Not yet discussed">\u25CB</span>`,
    in_progress: `<span class="tracker-status tracker-in-progress" title="In progress">\u25D0</span>`,
    discussed: `<span class="tracker-status tracker-discussed" title="Discussed">\u25CF</span>`,
  };

  let html = "";
  for (const point of points) {
    const icon = statusIcons[point.status] || statusIcons.pending;
    const noteHtml = point.note ? `<span class="tracker-note">${escapeHtml(point.note)}</span>` : "";
    html += `<div class="tracker-item tracker-${point.status}">
      ${icon}
      <span class="tracker-text">${escapeHtml(point.text)}</span>
      ${noteHtml}
    </div>`;
  }

  if (nudge) {
    html += `<div class="tracker-nudge">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>
      </svg>
      ${escapeHtml(nudge)}
    </div>`;
  }

  trackerItemsContainer.innerHTML = html;

  const discussedCount = points.filter(p => p.status === "discussed").length;
  trackerCount.textContent = `${discussedCount}/${points.length}`;
}

function handleDiscussionTrackerUpdate(data) {
  if (data.points && data.points.length > 0) {
    // If we were in auto-suggest waiting mode, activate the tracker
    if (trackerSetupMode === "auto" && !discussionTrackerMode) {
      discussionTrackerMode = true;
      trackerSetupMode = "active";
      trackerAutoWaiting.classList.add("hidden");
      trackerItemsContainer.classList.remove("hidden");
      discussionPoints = data.points.map(p => p.text);
    }
    renderDiscussionTracker(data.points, data.nudge || "");
  }
}

function handleDiscussionSuggestions(data) {
  if (!data.points || data.points.length === 0) return;
  const points = data.points.map(p => typeof p === "string" ? p : p.text || p);
  activateTrackerWithPoints(points);
}

// ---------------------------------------------------------------------------
// Event Listeners
// ---------------------------------------------------------------------------

startBtn.addEventListener("click", startListening);
stopBtn.addEventListener("click", stopListening);
document.getElementById("clear-btn").addEventListener("click", clearAll);

// Simulation mode toggle — dim mic controls when enabled
simulationToggle.addEventListener("change", () => {
  if (simulationToggle.checked) {
    micGroup.classList.add("dimmed");
    systemAudioLabel.classList.add("dimmed");
  } else {
    micGroup.classList.remove("dimmed");
    systemAudioLabel.classList.remove("dimmed");
  }
});

// Coaching mode toggle — send to server if connected
coachingToggle.addEventListener("change", () => {
  if (websocket && websocket.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify({
      type: "coaching_mode",
      enabled: coachingToggle.checked,
    }));
  }
});

// Modal controls
document.getElementById("modal-close-btn").addEventListener("click", closePostCallModal);
document.getElementById("modal-done-btn").addEventListener("click", closePostCallModal);

// Discussion Tracker mode selector buttons
document.getElementById("tracker-mode-manual").addEventListener("click", showManualEntry);
document.getElementById("tracker-mode-auto").addEventListener("click", showAutoSuggest);
document.getElementById("tracker-confirm-manual").addEventListener("click", confirmManualPoints);

// Initialize
loadClientContext();
enumerateAudioDevices();
setStatus("idle", "Ready");
