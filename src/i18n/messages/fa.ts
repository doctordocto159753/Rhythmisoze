/**
 * Persian message catalog.
 *
 * Authored, not translated word for word. Persian is a first-class presentation
 * of the same product (Playbook 11, gate G5), so where a literal rendering of
 * the English would read like a manual, the Persian says the same thing the way
 * a Persian speaker would say it.
 *
 * Conventions used here:
 *  - نیم‌فاصله (ZWNJ) is used correctly: می‌شود, نت‌ها, ساخته‌شده.
 *  - Technical words stay in the form Persian speakers actually use: MIDI, WAV,
 *    BPM. Inventing a Persian calque for MIDI would be less clear, not more
 *    (bilingual skill: "do not translate technical terms if the translation
 *    creates more confusion").
 *  - Latin fragments inside a sentence - BPM, MIDI, WAV, note names - are
 *    isolated at render time by `<Bdi>`, not by punctuation tricks here.
 */

import type { Messages } from './en';

export const fa: Messages = {
  meta: {
    localeName: 'فارسی',
    otherLocaleName: 'English',
    dir: 'rtl',
  },

  app: {
    name: 'ریتمیسوز',
    tagline: 'صدات رو به ساز تبدیل کن',
    description:
      'یک ایده‌ی موسیقایی را زمزمه کن، بخوان یا بیت‌باکس کن. ریتمیسوز آن را می‌نویسد، تمیزش می‌کند و با ساز واقعی پخش می‌کند.',
  },

  nav: {
    create: 'ساختن',
    workspace: 'اسکچ‌های من',
    switchLanguage: 'تغییر به انگلیسی',
    skipToContent: 'رفتن به محتوای اصلی',
  },

  landing: {
    lead: 'یک ایده را زمزمه کن. بشنو که نواخته می‌شود.',
    body: 'ضبط تو برای ساخت نسخهٔ خام به سرویس رونویسی فرستاده می‌شود. فایل موسیقی مستقیماً خوانده می‌شود و فایل اصلی آن دست‌نخورده می‌ماند.',
    start: 'شروع یک اسکچ',
    howItWorks: 'چطور کار می‌کند',
    steps: {
      start: { title: 'ضبط کن یا فایل بده', body: 'زمزمه، آواز، بیت‌باکس یا یک فایل. بدون تنظیم اولیه.' },
      record: { title: 'ضبط کن', body: 'تا شصت ثانیه، با هر سرعتی که ایده می‌خواهد.' },
      hear: { title: 'گوش کن', body: 'یک ساز انتخاب کن و میزان تمیزی را تنظیم کن.' },
    },
  },

  sourceInput: {
    title: 'یا با یک فایل شروع کن',
    audio: 'آپلود یک ضبط',
    audioInputLabel: 'انتخاب فایل صوتی برای آپلود',
    audioReadyHint: 'هر زمزمه، خط آوازی، ریتم یا اجرای ساز.',
    midi: 'وارد کردن MIDI',
    midiInputLabel: 'انتخاب فایل MIDI برای وارد کردن',
    midiHint: 'سرعت داخل فایل همراه نت‌ها وارد می‌شود.',
    reading: 'در حال خواندن فایل',
  },

  record: {
    arm: 'ضبط',
    opening: 'در حال باز کردن میکروفن',
    recording: 'در حال ضبط',
    stop: 'توقف',
    cancel: 'انصراف',
    again: 'ضبط دوباره',
    keepTake: 'همین را نگه دار',
    remaining: (seconds: string) => `${seconds} باقی مانده`,
    elapsed: (seconds: string) => `${seconds}`,
    tooQuiet: 'خیلی آرام است. به میکروفون نزدیک‌تر شو.',
    tooLoud: 'خیلی بلند است. کمی عقب‌تر برو.',
    listening: 'میکروفون روشن است.',
    permissionPrompt: 'ریتمیسوز برای ضبط به میکروفون نیاز دارد.',
    allowMicrophone: 'اجازه‌ی دسترسی به میکروفون',
  },

  process: {
    title: 'در حال تشخیص چیزی که خواندی',
    stages: {
      loading_model: 'آماده‌سازی مدل شنیدن',
      preparing_audio: 'خواندن ضبط تو',
      inferring: 'پیدا کردن نت‌ها',
      collecting: 'کنار هم گذاشتن',
      done: 'تمام',
    },
    firstTimeNote: 'بار اول مدل نت دانلود می‌شود. دفعه‌های بعد آنی است.',
    cancel: 'انصراف',
    retry: 'تلاش دوباره',
  },

  versions: {
    title: 'برداشت‌ها',
    help: 'یک اجرا، چند خوانش از آن. نسخه‌ی اصلی خودت همیشه اولی است.',
    names: {
      unprocessed: 'پردازش‌نشده',
      judge: 'همان چیزی که خواندی',
      teacher: 'مرتب‌شده',
      // «پرداخت» در فارسی برای صیقل‌دادن کار هنری به کار می‌رود؛ ترجمه‌ی
      // تحت‌اللفظی «اصلاح‌شده» بار عیب‌جویانه دارد و منظور را نمی‌رساند.
      'musician-refined': 'پرداخت‌شده',
      'musician-developed': 'یک قدم جلوتر',
      // «گسترش‌یافته» یعنی چیزی که بسط پیدا کرده، نه چیزی که فقط بلندتر شده.
      'musician-expanded': 'گسترش‌یافته',
    },
    hints: {
      unprocessed: 'مستقیم از موتور شنیدن، بدون هیچ اصلاحی.',
      judge: 'نزدیک‌ترین خوانش به چیزی که واقعاً خواندی.',
      teacher: 'همان ایده، منظم‌شده در ضرب و گام.',
      'musician-refined': 'همان ایده‌ی خودت، با پرداخت حرفه‌ای.',
      'musician-developed': 'همان ایده، یک قدم پیش‌تر برده‌شده.',
      'musician-expanded': 'همان ایده، بسط‌یافته به یک قطعه‌ی بلندتر.',
    },
    // همان دو نسخه، برای فایل MIDI واردشده صادقانه توصیف شده: چیزی خوانده نشده
    // و رونویسی‌ای در کار نبوده که ابهامی داشته باشد.
    importedHints: {
      unprocessed: 'فایل دقیقاً همان‌طور که رسید.',
      judge: 'همان نت‌ها — فایل واردشده نیازی به اصلاح ندارد.',
    },
    // همان دو نسخه، با نام‌هایی که به ریتم می‌خورد. «چیزی که نواختی» و «مرتب‌شده»
    // واژه‌های ملودی‌اند: ریتم نه داوری رونویسی دارد نه گام.
    rhythmNames: {
      unprocessed: 'همان الگو',
      teacher: 'جمع‌وجورشده',
    },
    rhythmHints: {
      unprocessed: 'هر ضربه دقیقاً همان‌جا که افتاد.',
      teacher: 'همان ضربه‌ها، نزدیک‌تر به ضرب.',
    },
    judgeRepaired: (count: number) => `${count} اصلاح`,
    judgeClean: 'چیزی نیاز به اصلاح نداشت.',
    teacherSuggestions: (count: number) => `${count} پیشنهاد`,
    teacherNone: 'پیشنهادی نیست — همین‌طور خوب است.',
    heardTempo: (bpm: number) => `شنیده‌شده روی ${bpm} BPM`,
    // حالت میانی: ضرب شنیده شده اما با اطمینان کامل نه. همان را به کار می‌بریم،
    // چون اجرا اجراست، ولی وانمود نمی‌کنیم که مطمئنیم.
    heardTempoUncertain: (bpm: number) => `شنیده‌شده حدود ${bpm} BPM`,
    freeTiming: 'زمان‌بندی آزاد',
    tempoNotHeard: 'در این اجرا ضرب ثابتی نبود، پس زمان‌بندی دقیقاً همان‌طور که اجرا کردی نگه داشته می‌شود.',

    /**
     * بخش نوازنده.
     *
     * قاعده‌ی متن: هیچ اصطلاح فنی. کسی که منتظر شنیدن موسیقی خودش است لازم
     * نیست بداند کدام مدل در حال اجراست.
     */
    musician: {
      title: 'یک قدم جلوتر ببر',
      intro: 'نسخه‌ی مرتب‌شده را به نوازنده بسپار تا سه خوانش دیگر برایت بسازد.',
      start: 'ساخت نسخه‌های نوازنده',
      queued: 'در نوبت است…',
      generatingGlobal: 'دارد کل ملودی را کار می‌کند…',
      refiningLocal: 'دارد چند عبارت را صیقل می‌دهد…',
      cancel: 'توقف',
      cancelled: 'متوقف شد. نسخه‌های دیگرت دست‌نخورده‌اند.',
      unavailable: 'نوازنده الان در دسترس نیست. بقیه‌ی چیزها سر جایشان است.',
      timedOut: 'بیش از حد طول کشید و متوقف شد. بقیه‌ی چیزها سر جایشان است.',
      failed: 'نوازنده نتوانست این یکی را تمام کند. بقیه‌ی چیزها سر جایشان است.',
      retry: 'تلاش دوباره',
      refinedSummary: 'همان ایده، صیقل‌خورده.',
      developedSummary: 'همان ایده، بسط‌یافته.',
      expandedSummary: 'ایده‌ات رشد کرده و به یک قطعه‌ی بلندتر تبدیل شده.',
      tryAnother: 'یکی دیگر بساز',
      tryAnotherHint: 'یک مجموعه‌ی تازه می‌سازد. نسخه‌های فعلی تا رسیدن نسخه‌های نو می‌مانند.',
      // شکست نیست: نسخه‌هایی ساخته شد، اما هیچ‌کدام آن‌قدر به ایده‌ی خود کاربر
      // نزدیک نماند که از فیلتر هویت رد شود، پس هیچ‌کدام ارائه نشد.
      refused:
        'هیچ نسخه‌ای از نوازنده آن‌قدر به ایده‌ی اصلی تو نزدیک نماند، برای همین این نسخه ارائه نشد. «یکی دیگر بساز» را بزن تا برداشت دیگری امتحان شود.',
      stale:
        'از وقتی این‌ها ساخته شدند نسخه‌ی مرتب‌شده را تغییر داده‌ای، پس دیگر ارائه نمی‌شوند. دوباره بساز تا با چیزی که الان داری بخواند.',
      keepNew: 'نسخه‌های نو را نگه دار',
      keepOld: 'همان قبلی‌ها را نگه دار',
      compareReady: 'نسخه‌های تازه آماده‌اند. کدام را نگه می‌داری؟',
      ready: 'نسخه‌های نوازنده آماده شد.',
      changedSpans: (count: number) => `${count} عبارت بازنویسی شد`,
      disabled: 'نسخه‌های نوازنده در این نسخه از برنامه فعال نیست.',
    },
  },

  review: {
    title: 'اسکچ تو',
    play: 'پخش',
    pause: 'مکث',
    restart: 'برگشت به ابتدا',
    cleanup: 'تمیزکاری',
    cleanupHelp: 'یک سر، دقیقاً همان چیزی است که خواندی. سر دیگر، کاملاً تمیز شده.',
    qualityGuard: 'شکل ملودی‌ات حفظ شد، چون تمیزکاری شدیدتر آن را تغییر می‌داد.',
    unclearMelody:
      'ملودی روشنی در ضبط پیدا نشد. نت‌ها را یکی‌یکی زمزمه کن و دوباره امتحان کن.',
    cleanupLevels: {
      raw: 'دقیقاً همان‌طور که خواندی',
      light: 'کمی مرتب',
      balanced: 'متعادل',
      tidy: 'مرتب',
      clean: 'کاملاً تمیز',
    },
    compareRaw: 'حالت خام را بشنو',
    compareClean: 'حالت تمیز را بشنو',
    notesHeard: (count: number) => `${count} نت`,
    hitsHeard: (count: number) => `${count} ضربه`,
    keyLabel: 'گام',
    keyUnknown: 'به‌قدر کافی روشن نیست',
    keyCorrect: 'تغییر گام',
    detail: 'جزئیات',
    detailHide: 'بستن جزئیات',
    classification: {
      title: 'تشخیص محتوای موسیقایی',
      detected: (type: string, confidence: number) => `${type} · اطمینان ${confidence}٪`,
      help: 'اگر این برداشت درست نیست، همین‌جا اصلاحش کن. منبع اصلی حفظ می‌شود.',
      corrected: 'مسیر پردازش پس از بازبینی اصلاح شد.',
      correctMelody: 'اصلاح: ملودی',
      correctRhythm: 'اصلاح: ریتم',
      classifierLabel: 'دسته‌بندی ورودی',
      reasoningLabel: 'دلیل دسته‌بندی',
      types: {
        melody: 'ملودی',
        polyphonic: 'ساز چندصدایی',
        rhythm: 'اجرای ریتمیک',
        mixed: 'ملودی و ریتم ترکیبی',
        unknown: 'ورودی نامشخص',
      },
    },
    analysis: {
      range: 'دامنه',
      detectedTempo: 'سرعت شنیده‌شده',
      yourTempo: 'نوشته‌شده روی',
      octaveFixes: 'پرش‌های اکتاوی حذف‌شده',
      snapped: 'نت‌های منتقل‌شده به گام',
      merged: 'تکه‌های ادغام‌شده',
      stepwise: 'حرکت پله‌ای',
      melodyConfidence: 'اطمینان ملودی',
    },
    empty: 'در این ضبط نتی پیدا نشد.',
    emptyHelp: 'کمی بلندتر زمزمه کن و بین نت‌ها فاصله‌ی کوتاه بگذار.',
  },

  pianoRoll: {
    label: 'نت‌ها در طول زمان',
    summary: (count: number, low: string, high: string, seconds: string) =>
      `${count} نت از ${low} تا ${high} در ${seconds} ثانیه.`,
    drumSummary: (count: number, seconds: string) => `${count} ضربه‌ی درام در ${seconds} ثانیه.`,
    noteAt: (name: string, seconds: string) => `${name} در ثانیه‌ی ${seconds}`,
    playhead: 'موقعیت پخش',
  },

  instruments: {
    title: 'ساز',
    preview: 'بشنو',
    stopPreview: 'توقف',
    select: 'همین را بردار',
    selected: 'انتخاب‌شده',
    loading: 'در حال بارگذاری',
    preparing: (percent: string) => `در حال کوک · ${percent}٪`,
    ready: 'آماده‌ی نواختن',
    fallbackReady: 'صدای سبک آماده است',
    loadFailed: 'این ساز بارگذاری نشد.',
    bestFor: (uses: string) => `مناسب برای ${uses}`,
    sampleSize: (megabytes: string) => `دانلود ${megabytes} مگابایت`,
    sources: {
      sample: 'صدای ضبط‌شده',
      synth: 'صدای داخلی',
    },
    credits: {
      title: 'اعتبار صداها',
      soundfontBy: 'سازبانک از',
      browserFilesBy: 'فایل‌های مرورگر از',
      recordedBy: 'ضبط‌شده به‌دست',
      and: 'و',
      sourceLink: 'منبع',
    },
    families: {
      keys: 'شستی‌دار',
      strings: 'زهی',
      winds: 'بادی',
      reeds: 'زبانه‌دار',
      percussion: 'کوبه‌ای',
    },
  },

  sound: {
    title: 'صدا',
    volume: 'بلندی',
    reverb: 'فضا',
  },

  exportPanel: {
    title: 'با خودت ببر',
    package: 'بسته‌ی کامل',
    packageHint:
      'یک فایل فشرده شامل صدای ساز، نت‌های قابل ویرایش، اطلاعات اسکچ و منبع اصلی در صورت وجود.',
    packageContents: 'داخل بسته',
    renderedAudio: 'صدای ساز',
    editableNotes: 'نت‌های قابل ویرایش',
    original: 'منبع اصلی',
    untouched: 'دست‌نخورده نگه داشته شده',
    downloadPackage: 'دانلود بسته‌ی کامل',
    individualFiles: 'فایل‌های جداگانه',
    wav: 'فایل صوتی',
    wavHint: 'یک فایل WAV که هرجا پخش می‌شود و می‌توانی برای کسی بفرستی.',
    midi: 'فایل نت',
    midiHint: 'یک فایل MIDI که در نرم‌افزارهای موسیقی باز می‌شود.',
    originalHint: 'همان فایل اصلی که با آن شروع کردی، بدون هیچ تغییری.',
    sourcePrivacy:
      'منبع اصلی دست‌نخورده و روی همین دستگاه می‌ماند؛ فقط در دانلودها قرار می‌گیرد و هنگام انتشار فرستاده نمی‌شود.',
    preparing: 'در حال آماده‌سازی',
    ready: 'آماده',
    download: 'دانلود',
    renderedWith: (instrument: string, cleanup: string) => `${instrument}، ${cleanup}`,
    noWatermark: 'هیچ واترمارکی به صدای تو اضافه نمی‌شود.',
  },

  workspace: {
    title: 'اسکچ‌های من',
    empty: 'هنوز چیزی اینجا نیست.',
    emptyAction: 'اولین ایده‌ات را ضبط کن',
    open: 'باز کردن',
    rename: 'تغییر نام',
    renameLabel: 'نام اسکچ',
    delete: 'حذف',
    deleteConfirm: (title: string) => `«${title}» حذف شود؟`,
    deleteConfirmBody: 'این کار آن را از این دستگاه پاک می‌کند. نسخه‌ی منتشرشده باقی می‌ماند.',
    deleteAlsoPublished: 'نسخه‌ی منتشرشده هم حذف شود',
    cancel: 'انصراف',
    savedAt: (date: string) => `ذخیره‌شده در ${date}`,
    storageWarning: 'فضای این مرورگر رو به اتمام است.',
    storageWarningBody:
      'نت‌هایت در امان‌اند. ممکن است صدای رندرشده نگه داشته نشود — هرچه را می‌خواهی دانلود کن.',
    count: (count: number) => `${count} اسکچ`,
    untitled: 'اسکچ بی‌نام',
  },

  publish: {
    title: 'انتشار',
    body: 'صدای رندرشده و فایل نت آپلود می‌شود تا هرکسی با داشتن لینک بتواند گوش کند.',
    privacyNote: 'ضبط اصلی تو هرگز آپلود نمی‌شود.',
    action: 'منتشر کن و لینک بگیر',
    publishing: 'در حال انتشار',
    published: 'منتشر شد',
    copyLink: 'کپی لینک',
    copied: 'کپی شد',
    manageNote:
      'این لینک را نزد خودت نگه دار — تنها راه حذف بعدی همین است. روی این دستگاه ذخیره شده.',
    unpublish: 'حذف از وب',
    unpublished: 'حذف شد.',
    disabled: 'انتشار روی این نسخه پیکربندی نشده است.',
    disabledHint: 'دانلود همچنان کار می‌کند.',
    titleLabel: 'برای این اسکچ نامی بگذار',
    titlePlaceholder: 'اسکچ بی‌نام',
  },

  share: {
    madeWith: (title: string) => `«${title}» — ساخته‌شده با ریتمیسوز`,
    play: 'پخش',
    pause: 'مکث',
    tryIt: 'خودت امتحان کن',
    tryItBody: 'یک ایده را زمزمه کن و بشنو که نواخته می‌شود. رایگان، در مرورگر.',
    notFound: 'این اسکچ اینجا نیست.',
    notFoundBody: 'شاید سازنده‌اش آن را حذف کرده باشد.',
    downloadAudio: 'دانلود صدا',
    details: (instrument: string, bpm: number) => `${instrument} · ${bpm} BPM`,
  },

  errors: {
    title: 'کار متوقف شد',
    mic_permission_denied: 'دسترسی به میکروفون برای این سایت مسدود است.',
    mic_unavailable: 'میکروفونی پیدا نشد.',
    mic_in_use: 'برنامه‌ی دیگری از میکروفون استفاده می‌کند.',
    recording_failed: 'ضبط ذخیره نشد.',
    decode_failed: 'این ضبط قابل خواندن نبود.',
    unsupported_file: 'یک فایل صوتی یا MIDI با فرمت پشتیبانی‌شده انتخاب کن.',
    file_too_large: 'این فایل برای باز شدن در اینجا بیش از حد بزرگ است.',
    audio_silent: 'چیزی ضبط نشد.',
    audio_clipped: 'صدای ضبط‌شده دچار اعوجاج است.',
    audio_too_short: 'این برای کار کردن خیلی کوتاه بود.',
    audio_too_long: 'این فایل از محدودیت ۶۰ ثانیه طولانی‌تر است.',
    midi_invalid: 'این فایل MIDI قابل خواندن نبود.',
    midi_empty: 'در این فایل MIDI نت قابل پخشی پیدا نشد.',
    model_load_failed: 'مدل شنیدن دانلود نشد.',
    transcription_failed: 'ضبط تو به نت تبدیل نشد.',
    transcription_unavailable: 'سرویس رونویسی اکنون در دسترس نیست.',
    transcription_empty: 'در این ضبط نتی پیدا نشد.',
    input_unrecognized: 'اجرای موسیقایی با اطمینان کافی تشخیص داده نشد.',
    melody_unclear: 'ملودی روشنی در ضبط پیدا نشد. نت‌ها را یکی‌یکی زمزمه کن.',
    transcription_cancelled: 'متوقف شد.',
    worker_unavailable: 'این مرورگر نمی‌تواند مرحله‌ی پردازش را اجرا کند.',
    retouch_failed: 'مرحله‌ی تمیزکاری شکست خورد.',
    instrument_load_failed: 'این ساز بارگذاری نشد.',
    render_failed: 'صدا ساخته نشد.',
    export_failed: 'فایل آماده نشد.',
    storage_quota_exceeded: 'فضای این مرورگر پر است.',
    storage_unavailable: 'این مرورگر اجازه‌ی ذخیره‌سازی نمی‌دهد.',
    storage_failed: 'ذخیره‌سازی شکست خورد.',
    publish_disabled: 'انتشار اینجا در دسترس نیست.',
    publish_upload_failed: 'آپلود کامل نشد.',
    publish_rejected: 'این مورد منتشر نشد.',
    publish_rate_limited: 'انتشار بیش از حد. یک دقیقه صبر کن و دوباره تلاش کن.',
    musician_unavailable: 'نوازنده الان در دسترس نیست.',
    musician_timeout: 'نوازنده بیش از حد طول کشید و متوقف شد.',
    musician_failed: 'نوازنده نتوانست آن را تمام کند.',
    musician_cancelled: 'ساخت متوقف شد.',
    network_unavailable: 'اتصالی برقرار نیست.',
    unsupported_browser: 'این مرورگر چیزی را که برنامه لازم دارد ندارد.',
    unknown: 'مشکلی پیش آمد.',
    recovery: {
      retry: 'تلاش دوباره',
      rerecord: 'ضبط دوباره',
      reload: 'بارگذاری دوباره‌ی صفحه',
      choose_other_instrument: 'انتخاب ساز دیگر',
      free_space: 'خالی کردن فضا',
      check_permissions: 'راهنمای اجازه‌ی میکروفون',
      none: 'برگشت',
    },
    hints: {
      mic_permission_denied:
        'روی قفل کنار نوار آدرس بزن، میکروفون را مجاز کن و صفحه را دوباره بارگذاری کن.',
      audio_silent: 'مطمئن شو میکروفون درست انتخاب شده، بعد دوباره ضبط کن.',
      audio_too_short: 'دست‌کم یک ثانیه ضبط کن.',
      melody_unclear: 'هر بار یک نت را واضح نگه دار و بین نت‌ها کمی فاصله بگذار.',
      model_load_failed: 'اتصالت را بررسی کن و دوباره تلاش کن.',
      storage_quota_exceeded: 'یک اسکچ قدیمی را حذف کن، یا دانلود و بعد حذفش کن.',
      unsupported_browser: 'آخرین نسخه‌ی کروم، اج، فایرفاکس یا سافاری را امتحان کن.',
    },
  },

  capability: {
    unsupportedTitle: 'این مرورگر نمی‌تواند ریتمیسوز را اجرا کند',
    unsupportedBody: 'برنامه به میکروفون و سیستم Web Audio نیاز دارد.',
    insecureTitle: 'این صفحه به اتصال امن نیاز دارد',
    insecureBody:
      'مرورگرها دسترسی به میکروفون را فقط روی HTTPS می‌دهند. مرورگر تو مشکلی ندارد — آدرسی که صفحه از آن باز شده امن نیست.',
    insecureHint:
      'صفحه را با https:// باز کن، یا با http://localhost که مرورگرها آن را امن حساب می‌کنند.',
    missing: 'موجود نیست:',
    names: {
      microphone: 'دسترسی به میکروفون',
      webAudio: 'Web Audio',
      mediaRecorder: 'ضبط صدا',
      offlineAudio: 'رندر آفلاین صدا',
      webWorker: 'پردازش در پس‌زمینه',
      indexedDb: 'ذخیره‌سازی محلی',
      webAssembly: 'WebAssembly',
      webgl2: 'گرافیک سه‌بعدی',
      cacheStorage: 'کش',
    },
  },

  motion: {
    label: 'جزئیات بصری',
    full: 'کامل',
    reduced: 'کاهش‌یافته',
    minimal: 'خاموش',
    hint: 'اگر صفحه کند حس می‌شود این را کم کن. روی صدا هیچ اثری ندارد.',
  },

  privacy: {
    localTitle: 'ضبط تو برای رونویسی فرستاده می‌شود',
    localBody:
      'صدا به سرویس رونویسی تنظیم‌شده فرستاده می‌شود. منبع اصلی برای خروجی خام همچنان دست‌نخورده نگه داشته می‌شود.',
    uploadTitle: 'این مرحله صدا را آپلود می‌کند',
    processedBy: (backend: string) => `پردازش‌شده با: ${backend}`,
    backends: {
      game: 'مدل گِیم روی سرور رونویسی',
      'melody-extraction': 'موتور ملودی انسانی، در مرورگر تو',
      'basic-pitch': 'مدل نت، در مرورگر تو',
      'basic-pitch-yin': 'مدل نت با مسیر ملودی، در مرورگر تو',
      'pitch-tracker': 'ردیاب زیروبمی داخلی، در مرورگر تو',
      'midi-import': 'فایل MIDI واردشده‌ی تو، در مرورگر',
      server: 'یک سرور',
    },
  },

  a11y: {
    recordButton: 'شروع ضبط',
    stopButton: 'توقف ضبط',
    levelMeter: 'سطح ورودی',
    levelValue: (percent: number) => `${percent} درصد`,
    waveform: 'شکل موج زنده',
    beat: (beat: number, total: number) => `ضرب ${beat} از ${total}`,
    processing: (stage: string, percent: number) => `${stage}، ${percent} درصد`,
    cleanupValue: (label: string) => label,
    playing: 'در حال پخش',
    stopped: 'متوقف',
  },

  units: {
    seconds: (value: string) => `${value} ثانیه`,
    bpm: (value: number) => `${value} BPM`,
    percent: (value: number) => `${value}٪`,
    megabytes: (value: string) => `${value} مگابایت`,
  },

  common: {
    back: 'برگشت',
    next: 'بعدی',
    done: 'تمام',
    close: 'بستن',
    loading: 'در حال بارگذاری',
    save: 'ذخیره',
    cancel: 'انصراف',
    or: 'یا',
  },
};
