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
    // Was: "Nothing is uploaded. Everything happens on your device until you
    // choose to publish." That stopped being universally true when the Musician
    // began sending symbolic note data to a server. The replacement says what
    // is still true and is specific about the exception rather than hedging --
    // vague privacy copy is worse than none, because it cannot be checked.
    body: 'Your recording is processed on your device. Only note data leaves it, and only if you ask the musician for extra versions.',
    start: 'Start a sketch',
    howItWorks: 'How it works',
    steps: {
      start: { title: 'Record or upload', body: 'Hum, sing, beatbox or bring a file. No setup.' },
      record: { title: 'Record', body: 'Up to sixty seconds, at whatever speed the idea wants.' },
      hear: { title: 'Hear it back', body: 'Pick an instrument and adjust how tidy it sounds.' },
    },
  },

  sourceInput: {
    title: 'Or begin with a file',
    audio: 'Upload a recording',
    audioInputLabel: 'Choose a recording to upload',
    audioReadyHint: 'Any hum, sung line, beat or instrument take.',
    midi: 'Import MIDI',
    midiInputLabel: 'Choose a MIDI file to import',
    midiHint: 'Its embedded tempo is imported with the notes.',
    reading: 'Reading file',
  },

  record: {
    arm: 'Record',
    opening: 'Opening the microphone',
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
    help: 'Same performance, different readings of it. Your original is always the first.',
    names: {
      unprocessed: 'Unprocessed',
      judge: 'What you played',
      teacher: 'Tidied up',
      'musician-refined': 'Shaped',
      'musician-developed': 'Taken further',
      'musician-expanded': 'Grown',
    },
    hints: {
      unprocessed: 'Straight from the listener, nothing corrected.',
      judge: 'The closest reading of what you actually sang.',
      teacher: 'The same idea, put in time and in key.',
      'musician-refined': 'Your idea, professionally shaped.',
      'musician-developed': 'Your idea, taken one step further.',
      'musician-expanded': 'Your idea, grown into a longer passage.',
    },
    /**
     * The same two versions, described honestly for an imported MIDI file.
     *
     * A MIDI file is already symbolic: nobody sang it here, and there was no
     * transcription to be uncertain about. "The closest reading of what you
     * actually sang" is a claim about listening to audio, and repeating it over
     * an imported file would describe work the app did not do.
     */
    importedHints: {
      unprocessed: 'The file exactly as it arrived.',
      judge: 'The same notes — an imported file needs no correcting.',
    },
    /**
     * The same two versions, named for a rhythm.
     *
     * "What you played" and "Tidied up" are melody words — they belong to a
     * pipeline that judges a transcription and then puts it in key. A rhythm has
     * neither stage. What it has is the pattern and a tidier reading of the same
     * pattern, so that is what the two entries say.
     */
    rhythmNames: {
      unprocessed: 'The pattern',
      teacher: 'Tightened',
    },
    rhythmHints: {
      unprocessed: 'Every hit exactly where it landed.',
      teacher: 'The same hits, pulled closer to the beat.',
    },
    judgeRepaired: (count: number) =>
      count === 1 ? '1 correction' : `${count} corrections`,
    judgeClean: 'Nothing needed correcting.',
    teacherSuggestions: (count: number) =>
      count === 1 ? '1 suggestion' : `${count} suggestions`,
    teacherNone: 'Nothing to suggest — this already works.',
    heardTempo: (bpm: number) => `heard at ${bpm} BPM`,
    // The middle state, and the reason it has its own string: the app measured
    // a pulse and is not certain of the number. It still uses it — the
    // performance is the performance — but it says so rather than either
    // claiming certainty or quietly swapping in the metronome.
    heardTempoUncertain: (bpm: number) => `heard at about ${bpm} BPM`,
    // Not "no tempo". The take has timing — it has the timing it was performed
    // with. What it does not have is a pulse, and saying so is the difference
    // between describing the material and calling it deficient.
    freeTiming: 'timed freely',
    // Only shown when there was genuinely nothing to measure.
    tempoNotHeard: 'No steady pulse here, so the timing is kept exactly as you performed it.',

    /**
     * The Musician area.
     *
     * Copy rule for everything below: no implementation words. A person waiting
     * for their music does not need to know which model is running, and naming
     * one would be a promise we would have to keep when it changes. Developer
     * diagnostics carry the real names; this does not.
     */
    musician: {
      title: 'Take it further',
      intro: 'Hand your tidied version to the musician and get three more readings back.',
      start: 'Create musician versions',
      // Present tense, no percentages. A progress bar we cannot honestly fill
      // is worse than a sentence that says what is happening.
      queued: 'Waiting its turn…',
      generatingGlobal: 'Working through the whole melody…',
      refiningLocal: 'Polishing a few phrases…',
      cancel: 'Stop',
      cancelled: 'Stopped. Your other versions are untouched.',
      // Failure copy names the consequence, not the cause: the useful fact is
      // that nothing was lost.
      unavailable: 'The musician is not reachable right now. Everything else still works.',
      timedOut: 'That took too long, so it was stopped. Everything else still works.',
      failed: 'The musician could not finish this one. Everything else still works.',
      retry: 'Try again',
      // The three AI versions, described by what they do to the *length* and
      // ambition of the idea rather than by how "good" they are. A user
      // choosing between them needs to know what will come back, not which one
      // the app prefers.
      refinedSummary: 'Same idea, polished.',
      developedSummary: 'Same idea, developed.',
      expandedSummary: 'The idea grown into a longer passage.',
      tryAnother: 'Try another',
      tryAnotherHint:
        'Generates a fresh set. Your current versions stay until the new ones arrive.',
      // Not failures. The musician ran, and the honest outcome was nothing to
      // offer -- said plainly, because a version quietly missing from the picker
      // is indistinguishable from a bug.
      // Not a failure, and not "nothing to add" either. Candidates *were*
      // produced; every one of them drifted far enough from the user's melody
      // that the identity check refused it, and the Teacher's own version was
      // returned instead of a variation pretending to be one. The old wording
      // read as a technical fault and described a decision that was never made.
      refused:
        'No Musician variation stayed close enough to your original idea, so this version was withheld. Try another for a different take.',
      stale:
        'You have changed the tidied version since these were made, so they are no longer offered. Generate again to match what you have now.',
      keepNew: 'Keep the new ones',
      keepOld: 'Keep the previous ones',
      compareReady: 'New versions are ready. Which do you want to keep?',
      // Announced to screen readers when generation finishes.
      ready: 'Musician versions are ready.',
      changedSpans: (count: number) =>
        count === 1 ? '1 phrase reworked' : `${count} phrases reworked`,
      disabled: 'Musician versions are not available in this build.',
    },
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
    classification: {
      title: 'Detected material',
      detected: (type: string, confidence: number) => `${type} · ${confidence}% confidence`,
      help: 'If that reading is wrong, correct it here. Your original source is kept.',
      corrected: 'Route corrected after review.',
      correctMelody: 'Correct: melody',
      correctRhythm: 'Correct: rhythm',
      classifierLabel: 'Input classifier',
      reasoningLabel: 'Classifier reasoning',
      types: {
        melody: 'Melody',
        polyphonic: 'Polyphonic instrument',
        rhythm: 'Rhythmic performance',
        mixed: 'Mixed melody and rhythm',
        unknown: 'Unclear input',
      },
    },
    analysis: {
      range: 'Range',
      detectedTempo: 'Speed heard',
      yourTempo: 'Written at',
      octaveFixes: 'Octave slips removed',
      snapped: 'Notes nudged into key',
      merged: 'Fragments merged',
      stepwise: 'Stepwise movement',
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
    input_unrecognized: 'Could not confidently identify a musical performance.',
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
    musician_unavailable: 'The musician is not reachable right now.',
    musician_timeout: 'The musician took too long, so it was stopped.',
    musician_failed: 'The musician could not finish that one.',
    musician_cancelled: 'Generation stopped.',
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
    localTitle: 'Your recording stays on your device',
    localBody:
      'Your audio is processed in this browser and is never uploaded. Asking the musician for extra versions sends note data — not your recording — to our server.',
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
