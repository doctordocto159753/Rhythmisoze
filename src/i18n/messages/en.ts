/**
 * English message catalog - the shape of record for the whole UI.
 *
 * `Messages` is derived from this object, and `fa.ts` is typed as `Messages`.
 * A key added here and not translated is a type error, which is how US-0102's
 * "missing translation keys fail visibly in development/CI" is enforced: the
 * typecheck step in CI is the check.
 *
 * Tone (Q-D3: minimal and direct): say the thing, offer the next action, stop.
 * No exclamation marks, no encouragement the user did not ask for, and no
 * production vocabulary where an ordinary word exists - "cleanup" rather than
 * "quantization", "key" only where it is genuinely useful.
 */

export const en = {
  meta: {
    localeName: 'English',
    otherLocaleName: 'فارسی',
    // Typed as the union so `Messages` keeps it narrow rather than widening
    // it to `string`; every other value widens on purpose so `fa.ts` can differ.
    dir: 'ltr' as 'ltr' | 'rtl',
  },

  app: {
    name: 'Rhythmisoze',
    tagline: 'Turn your voice into an instrument',
    description:
      'Hum, sing or beatbox a musical idea. Rhythmisoze writes it down, tidies it up and plays it back on a real instrument.',
  },

  nav: {
    create: 'Create',
    workspace: 'My sketches',
    switchLanguage: 'Switch to Persian',
    skipToContent: 'Skip to main content',
  },

  landing: {
    lead: 'Hum an idea. Hear it played back.',
    body: 'Nothing is uploaded. Everything happens on your device until you choose to publish.',
    start: 'Start a sketch',
    howItWorks: 'How it works',
    steps: {
      tempo: { title: 'Set the pulse', body: 'Tap along at the speed you have in mind.' },
      record: { title: 'Record', body: 'You get a count-in, then up to sixty seconds.' },
      hear: { title: 'Hear it back', body: 'Pick an instrument and adjust how tidy it sounds.' },
    },
  },

  mode: {
    label: 'What are you going to make?',
    melody: 'A tune',
    melodyHint: 'Hum or sing it.',
    rhythm: 'A beat',
    rhythmHint: 'Beatbox it.',
    changeWarning: 'Changing this clears the current take.',
  },

  melodyInput: {
    label: 'What will you record?',
    voice: 'Melody mode',
    voiceHint: 'For humming, singing or whistling. Follows one melody line.',
    instrument: 'Instrument mode',
    instrumentHint: 'For guitar, piano or other sounds that may play several notes.',
  },

  tempo: {
    label: 'Speed',
    tapPrompt: 'Tap four times at your speed',
    tapMore: (remaining: number) => `${remaining} more`,
    tapAgain: 'Tap again',
    unit: 'BPM',
    sliderLabel: 'Beats per minute',
    notSet: 'Not set yet',
    metronome: 'Click',
    metronomeOn: 'Click on',
    metronomeOff: 'Click off',
    meter: 'Beats in a bar',
    why: 'The click keeps your timing steady. It makes everything after this work.',
  },

  sourceInput: {
    title: 'Or begin with a file',
    audio: 'Upload a recording',
    audioInputLabel: 'Choose a recording to upload',
    audioNeedsTempo: 'Move the slider or tap four times to set tempo first.',
    audioReadyHint: 'Uses the tempo you set above.',
    midi: 'Import MIDI',
    midiInputLabel: 'Choose a MIDI file to import',
    midiHint: 'Its embedded tempo is imported with the notes.',
    reading: 'Reading file',
  },

  record: {
    arm: 'Record',
    countdown: 'Get ready',
    countIn: (beat: number) => `${beat}`,
    recording: 'Recording',
    stop: 'Stop',
    cancel: 'Cancel',
    again: 'Record again',
    keepTake: 'Keep this take',
    remaining: (seconds: string) => `${seconds} left`,
    elapsed: (seconds: string) => `${seconds}`,
    tooQuiet: 'Very quiet. Move closer to the microphone.',
    tooLoud: 'Too loud. Move back a little.',
    listening: 'Microphone is on.',
    permissionPrompt: 'Rhythmisoze needs your microphone to record.',
    allowMicrophone: 'Allow microphone',
  },

  process: {
    title: 'Working out what you sang',
    stages: {
      loading_model: 'Getting the listener ready',
      preparing_audio: 'Reading your take',
      inferring: 'Finding the notes',
      collecting: 'Putting it together',
      done: 'Done',
    },
    firstTimeNote: 'The first time, this downloads the note model. After that it is instant.',
    cancel: 'Cancel',
    retry: 'Try again',
  },

  versions: {
    title: 'Interpretations',
    help: 'Same performance, four readings of it. Your original is always the first.',
    names: {
      unprocessed: 'Unprocessed',
      judge: 'What you played',
      teacher: 'Tidied up',
    },
    hints: {
      unprocessed: 'Straight from the listener, nothing corrected.',
      judge: 'The closest reading of what you actually sang.',
      teacher: 'The same idea, put in time and in key.',
    },
    judgeRepaired: (count: number) =>
      count === 1 ? '1 correction' : `${count} corrections`,
    judgeClean: 'Nothing needed correcting.',
    teacherSuggestions: (count: number) =>
      count === 1 ? '1 suggestion' : `${count} suggestions`,
    teacherNone: 'Nothing to suggest — this already works.',
    heardTempo: (bpm: number) => `heard at ${bpm} BPM`,
    tappedTempo: (bpm: number) => `your ${bpm} BPM`,
    tempoNotHeard: 'No clear pulse was heard, so your tapped speed is used.',
    halfOrDouble: (heard: number, tapped: number) =>
      `You tapped ${tapped} BPM and this sounds like ${heard} BPM — likely counted twice as fast or twice as slow.`,
    different: (heard: number, tapped: number) =>
      `You tapped ${tapped} BPM; this sounds like ${heard} BPM.`,
  },

  review: {
    title: 'Your sketch',
    play: 'Play',
    pause: 'Pause',
    restart: 'Back to start',
    cleanup: 'Cleanup',
    cleanupHelp: 'Left is exactly what you sang. Right is fully tidied up.',
    qualityGuard: 'Your melody contour was kept because stronger cleanup would have changed it.',
    unclearMelody:
      'Your recording does not contain a clear melody. Try humming one note after another.',
    cleanupLevels: {
      raw: 'Exactly as sung',
      light: 'Lightly tidied',
      balanced: 'Balanced',
      tidy: 'Tidy',
      clean: 'Fully tidied',
    },
    compareRaw: 'Hear it raw',
    compareClean: 'Hear it tidied',
    notesHeard: (count: number) => `${count} notes`,
    hitsHeard: (count: number) => `${count} hits`,
    keyLabel: 'Key',
    keyUnknown: 'Not clear enough to say',
    keyCorrect: 'Change key',
    detail: 'Details',
    detailHide: 'Hide details',
    analysis: {
      range: 'Range',
      detectedTempo: 'Speed heard',
      yourTempo: 'Your speed',
      octaveFixes: 'Octave slips removed',
      snapped: 'Notes nudged into key',
      merged: 'Fragments merged',
      stepwise: 'Stepwise movement',
      tempoMismatch: 'That differs from your tapped speed. If the result feels off, retap.',
      melodyConfidence: 'Melody confidence',
    },
    empty: 'No notes were found in that take.',
    emptyHelp: 'Try humming a little louder, and leave small gaps between notes.',
  },

  pianoRoll: {
    label: 'Notes over time',
    summary: (count: number, low: string, high: string, seconds: string) =>
      `${count} notes from ${low} to ${high} over ${seconds} seconds.`,
    drumSummary: (count: number, seconds: string) => `${count} drum hits over ${seconds} seconds.`,
    noteAt: (name: string, seconds: string) => `${name} at ${seconds} seconds`,
    playhead: 'Playback position',
  },

  instruments: {
    title: 'Instrument',
    preview: 'Hear it',
    stopPreview: 'Stop',
    select: 'Use this',
    selected: 'In use',
    loading: 'Loading',
    preparing: (percent: string) => `Tuning · ${percent}%`,
    ready: 'Ready to play',
    fallbackReady: 'Lightweight sound ready',
    loadFailed: 'That instrument would not load.',
    bestFor: (uses: string) => `Best for ${uses}`,
    sampleSize: (megabytes: string) => `${megabytes} MB download`,
    sources: {
      sample: 'Recorded sound',
      synth: 'Built-in sound',
    },
    credits: {
      title: 'Sound credits',
      soundfontBy: 'Soundfont by',
      browserFilesBy: 'browser files by',
      recordedBy: 'Recorded by',
      and: 'and',
      sourceLink: 'Source',
    },
    families: {
      keys: 'Keys',
      strings: 'Strings',
      winds: 'Winds',
      reeds: 'Reeds',
      percussion: 'Percussion',
    },
  },

  sound: {
    title: 'Sound',
    volume: 'Volume',
    reverb: 'Room',
  },

  exportPanel: {
    title: 'Take it with you',
    package: 'Complete package',
    packageHint:
      'A ZIP with the instrument render, editable notes, sketch details and your original source when available.',
    packageContents: 'Inside the package',
    renderedAudio: 'Instrument render',
    editableNotes: 'Editable notes',
    original: 'Original source',
    untouched: 'Kept untouched',
    downloadPackage: 'Download complete package',
    individualFiles: 'Individual files',
    wav: 'Audio file',
    wavHint: 'A WAV you can play anywhere or send to someone.',
    midi: 'Note file',
    midiHint: 'A MIDI file you can open in music software.',
    originalHint: 'The exact file you began with, unchanged.',
    sourcePrivacy:
      'Your original stays untouched and on this device. It is included only in your downloads, never when publishing.',
    preparing: 'Preparing',
    ready: 'Ready',
    download: 'Download',
    renderedWith: (instrument: string, cleanup: string) => `${instrument}, ${cleanup}`,
    noWatermark: 'No watermark is added to your audio.',
  },

  workspace: {
    title: 'My sketches',
    empty: 'Nothing here yet.',
    emptyAction: 'Record your first idea',
    open: 'Open',
    rename: 'Rename',
    renameLabel: 'Sketch name',
    delete: 'Delete',
    deleteConfirm: (title: string) => `Delete “${title}”?`,
    deleteConfirmBody: 'This removes it from this device. A published copy stays online.',
    deleteAlsoPublished: 'Also remove the published copy',
    cancel: 'Cancel',
    savedAt: (date: string) => `Saved ${date}`,
    storageWarning: 'This browser is running low on space.',
    storageWarningBody:
      'Your notes are safe. Rendered audio may not be kept — download anything you want to keep.',
    count: (count: number) => (count === 1 ? '1 sketch' : `${count} sketches`),
    untitled: 'Untitled sketch',
  },

  publish: {
    title: 'Publish',
    body: 'This uploads the rendered audio and the note file so anyone with the link can listen.',
    privacyNote: 'Your original recording is never uploaded.',
    action: 'Publish and get a link',
    publishing: 'Publishing',
    published: 'Published',
    copyLink: 'Copy link',
    copied: 'Copied',
    manageNote:
      'Keep this link private — it is the only way to remove the sketch later. It is saved on this device.',
    unpublish: 'Remove from the web',
    unpublished: 'Removed.',
    disabled: 'Publishing is not configured on this deployment.',
    disabledHint: 'Downloading still works.',
    titleLabel: 'Name this sketch',
    titlePlaceholder: 'Untitled sketch',
  },

  share: {
    madeWith: (title: string) => `“${title}” — made with Rhythmisoze`,
    play: 'Play',
    pause: 'Pause',
    tryIt: 'Make your own',
    tryItBody: 'Hum an idea and hear it played back. Free, in your browser.',
    notFound: 'This sketch is not here.',
    notFoundBody: 'It may have been removed by whoever made it.',
    downloadAudio: 'Download audio',
    details: (instrument: string, bpm: number) => `${instrument} · ${bpm} BPM`,
  },

  errors: {
    title: 'Something stopped',
    mic_permission_denied: 'The microphone is blocked for this site.',
    mic_unavailable: 'No microphone was found.',
    mic_in_use: 'Another app is using the microphone.',
    recording_failed: 'The recording did not save.',
    decode_failed: 'That recording could not be read.',
    unsupported_file: 'Choose an audio or MIDI file in a supported format.',
    file_too_large: 'That file is too large to open here.',
    audio_silent: 'Nothing was recorded.',
    audio_clipped: 'The recording is distorted.',
    audio_too_short: 'That was too short to work with.',
    audio_too_long: 'That file is longer than the 60-second limit.',
    midi_invalid: 'That MIDI file could not be read.',
    midi_empty: 'No playable notes were found in that MIDI file.',
    model_load_failed: 'The listener could not be downloaded.',
    transcription_failed: 'Your take could not be read as notes.',
    transcription_empty: 'No notes were found in that take.',
    melody_unclear:
      'Your recording does not contain a clear melody. Try humming one note after another.',
    transcription_cancelled: 'Stopped.',
    worker_unavailable: 'This browser cannot run the processing step.',
    retouch_failed: 'The cleanup step failed.',
    instrument_load_failed: 'That instrument would not load.',
    render_failed: 'The audio could not be produced.',
    export_failed: 'The file could not be prepared.',
    storage_quota_exceeded: 'This browser is out of space.',
    storage_unavailable: 'This browser will not let the app save anything.',
    storage_failed: 'Saving failed.',
    publish_disabled: 'Publishing is not available here.',
    publish_upload_failed: 'The upload did not finish.',
    publish_rejected: 'That could not be published.',
    publish_rate_limited: 'Too many publishes. Wait a minute and try again.',
    network_unavailable: 'No connection.',
    unsupported_browser: 'This browser is missing something the app needs.',
    unknown: 'Something went wrong.',
    recovery: {
      retry: 'Try again',
      rerecord: 'Record again',
      reload: 'Reload the page',
      choose_other_instrument: 'Choose another instrument',
      free_space: 'Free up space',
      check_permissions: 'How to allow the microphone',
      none: 'Go back',
    },
    hints: {
      mic_permission_denied:
        'Open the padlock in the address bar, allow the microphone, then reload.',
      audio_silent: 'Check that the right microphone is selected, then record again.',
      audio_too_short: 'Record for at least a second.',
      melody_unclear: 'Use one steady note at a time and leave a small gap between notes.',
      model_load_failed: 'Check your connection and try again.',
      storage_quota_exceeded: 'Delete an old sketch, or download and remove one.',
      unsupported_browser: 'Try the latest Chrome, Edge, Firefox or Safari.',
    },
  },

  capability: {
    unsupportedTitle: 'This browser cannot run Rhythmisoze',
    unsupportedBody: 'The app needs the microphone and the Web Audio system.',
    insecureTitle: 'This page needs a secure connection',
    insecureBody:
      'Browsers only allow microphone access over HTTPS. Your browser is fine — the address this page was opened from is not secure.',
    insecureHint:
      'Open it at https://, or at http://localhost, which browsers treat as secure.',
    missing: 'Missing:',
    names: {
      microphone: 'microphone access',
      webAudio: 'Web Audio',
      mediaRecorder: 'audio recording',
      offlineAudio: 'offline audio rendering',
      webWorker: 'background processing',
      indexedDb: 'local storage',
      webAssembly: 'WebAssembly',
      webgl2: '3D graphics',
      cacheStorage: 'caching',
    },
  },

  motion: {
    label: 'Visual detail',
    full: 'Full',
    reduced: 'Reduced',
    minimal: 'Off',
    hint: 'Lower this if the page feels slow. It never changes the sound.',
  },

  privacy: {
    localTitle: 'Everything is on your device',
    localBody:
      'Your recording is processed in this browser. It is not sent anywhere unless you publish.',
    uploadTitle: 'This step uploads audio',
    processedBy: (backend: string) => `Processed by: ${backend}`,
    backends: {
      'melody-extraction': 'the human melody engine, in your browser',
      'basic-pitch': 'the note model, in your browser',
      'basic-pitch-yin': 'the note model with melody contour, in your browser',
      'pitch-tracker': 'the built-in pitch tracker, in your browser',
      'midi-import': 'your imported MIDI file, in your browser',
      server: 'a server',
    },
  },

  a11y: {
    recordButton: 'Start recording',
    stopButton: 'Stop recording',
    levelMeter: 'Input level',
    levelValue: (percent: number) => `${percent} percent`,
    waveform: 'Live waveform',
    beat: (beat: number, total: number) => `Beat ${beat} of ${total}`,
    processing: (stage: string, percent: number) => `${stage}, ${percent} percent`,
    cleanupValue: (label: string) => label,
    playing: 'Playing',
    stopped: 'Stopped',
  },

  units: {
    seconds: (value: string) => `${value}s`,
    bpm: (value: number) => `${value} BPM`,
    percent: (value: number) => `${value}%`,
    megabytes: (value: string) => `${value} MB`,
  },

  common: {
    back: 'Back',
    next: 'Next',
    done: 'Done',
    close: 'Close',
    loading: 'Loading',
    save: 'Save',
    cancel: 'Cancel',
    or: 'or',
  },
};

/**
 * The contract every locale must satisfy.
 *
 * Note the absence of `as const`: string values widen to `string`, so a
 * translation is allowed to differ in wording but not in shape. Add a key here
 * and `fa.ts` stops compiling until it is translated.
 */
export type Messages = typeof en;
