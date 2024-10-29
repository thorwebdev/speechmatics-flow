const YOUR_API_KEY = '790UTOwu1UJLWs6jhqM2BAn8kWCzfw5n';
// State management
const state = {
  running: false,
  flowStatus: 'disconnected',
  audioContext: null,
  mediaStream: null,
  processor: null,
  ws: null,
  playbackStartTime: 0,
  prompts: [],
  audioSequence: 0,
  audioChunkQueue: [],
  isReading: false,
};

// DOM elements
const elements = {
  button: null,
  buttonForce: null,
  dropdown: null,
  statusDiv: null,
  sessionIdDiv: null,
  passiveStateSpan: null,
  promptsDiv: null,
};

document.addEventListener('DOMContentLoaded', initializeApp);

function initializeApp() {
  cacheElements();
  updateStatus('disconnected');
  fetchPersonas(elements.dropdown);
  addEventListeners();

  console.log(YOUR_API_KEY);
  if (YOUR_API_KEY === 'YOUR_API_KEY') {
    alert("Don't forget to set YOUR_API_KEY in index.js!");
  }
}

function cacheElements() {
  elements.button = document.getElementById('session-button');
  elements.buttonForce = document.getElementById('session-button-force-stop');
  elements.dropdown = document.getElementById('persona-dropdown');
  elements.statusDiv = document.getElementById('status');
  elements.sessionIdDiv = document.getElementById('session-id');
  elements.passiveStateSpan = document.getElementById('passive-state');
  elements.promptsDiv = document.getElementById('prompts');
}

function addEventListeners() {
  elements.button.addEventListener('click', toggleSession);
  elements.buttonForce.addEventListener('click', forceStopSession);
}

function toggleSession() {
  if (!state.running) {
    const presetId = elements.dropdown.value;
    if (presetId) {
      startSession(presetId);
      elements.button.textContent = 'STOP';
      elements.buttonForce.style.display = 'block';
    } else {
      alert('Please select a persona.');
    }
  } else {
    stopSession(false);
    elements.button.textContent = 'START';
    elements.buttonForce.style.display = 'none';
  }
  state.running = !state.running;
}

function forceStopSession() {
  if (state.running) {
    elements.button.textContent = 'START';
    elements.buttonForce.style.display = 'none';
    stopSession(true);
  }
  state.running = false;
}

function fetchPersonas(dropdown) {
  const personaOptions = [
    { label: 'Default', value: 'default' },
    { label: 'Amelia', value: 'flow-service-assistant-amelia' },
    { label: 'Humphrey', value: 'flow-service-assistant-humphrey' },
  ];
  personaOptions.forEach((option) => {
    const optionElement = document.createElement('option');
    optionElement.value = option.value;
    optionElement.textContent = option.label;
    dropdown.appendChild(optionElement);
  });
}

async function startSession(presetId) {
  try {
    state.playbackStartTime = 0;
    state.audioSequence = 0;
    state.prompts = [];
    updatePrompts();

    await setupAudioStream();

    setupWebSocket(presetId);
  } catch (error) {
    alert('Unable to access the microphone.');
    console.error('Error accessing microphone:', error);
  }
}

async function setupAudioStream() {
  state.mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      sampleRate: 16000,
      sampleSize: 16,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  state.audioContext = new AudioContext({ sampleRate: 16000 });
  const input = state.audioContext.createMediaStreamSource(state.mediaStream);
  state.processor = state.audioContext.createScriptProcessor(512, 1, 1);

  input.connect(state.processor);
  state.processor.connect(state.audioContext.destination);
}

async function fetchJWTToken() {
  try {
    const response = await fetch(
      'https://mp.speechmatics.com/v1/api_keys?type=flow',
      {
        method: 'post',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${YOUR_API_KEY}`, //Change this before adding to docs as my personal token!!
        },
        body: JSON.stringify({
          ttl: 500,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return data.key_value;
  } catch (error) {
    console.error('Error fetching JWT token', error);
    throw error; // Re-throw the error for the caller to handle
  }
}

async function setupWebSocket(presetId) {
  const jwt = await fetchJWTToken();
  if (!jwt) {
    throw new Error('JWT token not found');
  }
  const wsUrl = new URL('/v1/flow', 'wss://flow.api.speechmatics.com');
  wsUrl.searchParams.append('jwt', jwt);
  state.ws = new WebSocket(wsUrl.toString());

  state.ws.onopen = () => handleWebSocketOpen(presetId);
  state.ws.onmessage = handleWebSocketMessage;
  state.ws.onerror = handleWebSocketError;
  state.ws.onclose = handleWebSocketClose;

  state.processor.onaudioprocess = handleAudioProcess;
}

function handleWebSocketOpen(presetId) {
  console.log('WebSocket connected');
  updateStatus('starting');
  sendStartConversationMessage(presetId);
}

function sendStartConversationMessage(presetId) {
  const message = {
    message: 'StartConversation',
    conversation_config: {
      template_id: presetId,
      template_variables: {
        persona: 'You are an aging English rock star named Roger Godfrey.',
        style:
          "Be helpful, but don't interrupt while contestants are thinking what's in the bag!",
        context: `You're a game show host for the popular memory game "I packed my bag". Make sure the order of items is correct. Ask how many contestants are playing, and ask for their names. Then start the game!`,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    },
    audio_format: {
      type: 'raw',
      encoding: 'pcm_s16le',
      sample_rate: 16000,
    },
  };
  state.ws.send(JSON.stringify(message));
}

function handleWebSocketMessage(event) {
  if (event.data instanceof Blob) {
    handleAudioMessage(event.data);
  } else {
    handleJsonMessage(JSON.parse(event.data));
  }
}

function handleAudioMessage(blob) {
  state.audioChunkQueue.push(blob);
  if (!state.isReading) {
    processNextAudioChunk();
  }
}

function handleJsonMessage(data) {
  if (data.audio) {
    data.audio.forEach((frame) => playAudio(frame, state.audioContext));
  }
  if (data.event && data.event.sessionId) {
    updateSessionId(data.event.sessionId);
  }
  if (data.passive !== undefined) {
    updatePassiveState(data.passive);
  }
  if (data.prompt) {
    addPrompt(data.prompt);
  }
  if (data.message) {
    handleMessageUpdate(data);
  }
}

function handleMessageUpdate(data) {
  switch (data.message) {
    case 'Info':
      if (data.type === 'status_update' && data.event && data.event.status) {
        updateStatus(data.event.status);
      }
      break;
    case 'Warning':
    case 'Error':
      console.log(data);
      break;
    case 'ConversationStarted':
      console.log('received ConversationStarted', data);
      updateStatus('running');
      updateSessionId(data.id);
      break;
    case 'ConversationEnded':
      if (state.ws.readyState === WebSocket.OPEN) {
        console.log('Closing session on ConversationEnded', data);
        closeWebSocket();
      }
      break;
  }
}

function handleWebSocketError(error) {
  console.error('WebSocket error:', error);
}

function handleWebSocketClose() {
  console.log('WebSocket closed');
  updateStatus('disconnected');
}

function handleAudioProcess(event) {
  const inputBuffer = event.inputBuffer.getChannelData(0);
  const pcm16Array = float32ToPcm16(inputBuffer);

  if (
    state.flowStatus === 'running' &&
    state.ws.readyState === WebSocket.OPEN
  ) {
    state.ws.send(pcm16Array.buffer);
    state.audioSequence++;
  }
}

function stopSession(force) {
  if (state.ws) {
    const endMessage = {
      message: 'AudioEnded',
      last_seq_no: state.audioSequence,
    };
    console.log('Sending AudioEnded: ', endMessage);
    state.ws.send(JSON.stringify(endMessage));

    if (force) {
      console.log('Closing session - forced');
      closeWebSocket();
    }
  }
}

function closeWebSocket() {
  state.ws.close();
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((track) => track.stop());
  }
  if (state.processor) {
    state.processor.disconnect();
  }
  if (state.audioContext) {
    state.audioContext.close();
  }
}

function updateStatus(status) {
  state.flowStatus = status;
  elements.statusDiv.textContent = status.toUpperCase();
}

function updateSessionId(sessionId) {
  elements.sessionIdDiv.textContent = sessionId;
}

function updatePassiveState(passive) {
  elements.passiveStateSpan.textContent = passive ? 'True' : 'False';
}

function addPrompt(prompt) {
  const existingPromptIndex = state.prompts.findIndex(
    (p) => p.id === prompt.id
  );
  if (existingPromptIndex !== -1) {
    state.prompts[existingPromptIndex] = prompt;
  } else {
    state.prompts.push(prompt);
  }
  updatePrompts();
}

function updatePrompts() {
  elements.promptsDiv.innerHTML = '';
  state.prompts.forEach((p) => {
    const promptDiv = document.createElement('div');
    promptDiv.className = 'text-right pl-10';
    promptDiv.innerHTML = escapeHTML(p.prompt);
    elements.promptsDiv.appendChild(promptDiv);

    const responseDiv = document.createElement('div');
    responseDiv.className = 'italic pr-10';
    responseDiv.innerHTML = escapeHTML(p.response);
    elements.promptsDiv.appendChild(responseDiv);
  });
  elements.promptsDiv.scrollTop = elements.promptsDiv.scrollHeight;
}

function playAudio(base64String, audioContext) {
  const pcm16ArrayBuffer = base64ToArrayBuffer(base64String);
  playBinaryAudio(pcm16ArrayBuffer, audioContext);
}

function playBinaryAudio(pcm16ArrayBuffer, audioContext) {
  const float32Array = pcm16ToFloat32(pcm16ArrayBuffer);
  const audioBuffer = audioContext.createBuffer(1, float32Array.length, 16000);
  audioBuffer.copyToChannel(float32Array, 0);

  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;

  const currentTime = audioContext.currentTime;
  if (state.playbackStartTime < currentTime) {
    state.playbackStartTime = currentTime;
  }

  source.connect(audioContext.destination);
  source.start(state.playbackStartTime);

  state.playbackStartTime += audioBuffer.duration;
}

function processNextAudioChunk() {
  if (state.audioChunkQueue.length > 0) {
    state.isReading = true;
    const frame = state.audioChunkQueue.shift();
    const reader = new FileReader();
    reader.onload = function () {
      const arrayBuffer = reader.result;
      const byteBuffer = new Uint8Array(arrayBuffer);
      playBinaryAudio(byteBuffer.buffer, state.audioContext);
      processNextAudioChunk();
    };
    reader.readAsArrayBuffer(frame);
  } else {
    state.isReading = false;
  }
}

/**
 * Helper to convert PCM16 to Float32
 * @param {*} pcm16ArrayBuffer
 * @returns
 */
const pcm16ToFloat32 = (pcm16ArrayBuffer) => {
  const pcm16 = new Int16Array(pcm16ArrayBuffer);
  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    float32[i] = pcm16[i] / 32768; // Convert PCM16 to Float32
  }
  return float32;
};

/**
 * Helper to convert Float32 to PCM16
 * @param {*} float32Array
 * @returns
 */
const float32ToPcm16 = (float32Array) => {
  const pcm16Array = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    pcm16Array[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return pcm16Array;
};

/**
 * Helper to convert PCM16 to base64
 * @param {*} int16AudioData
 * @returns
 */
const pcm16ToBase64 = (int16AudioData) => {
  const uint8AudioData = new Uint8Array(int16AudioData.buffer);
  let binaryString = '';
  uint8AudioData.forEach((byte) => {
    binaryString += String.fromCharCode(byte);
  });
  return btoa(binaryString);
};

/**
 * Helper to convert base64 to ArrayBuffer
 * @param {*} base64
 * @returns
 */
const base64ToArrayBuffer = (base64) => {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
};

/**
 * Helper to escape HTML
 * @param {string} unsafe
 * @returns {string}
 */
const escapeHTML = (unsafe) => {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};
