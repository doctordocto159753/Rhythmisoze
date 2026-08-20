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
    body: 'چیزی آپلود نمی‌شود. تا وقتی خودت نخواهی منتشر کنی، همه‌چیز روی دستگاه خودت می‌ماند.',
    start: 'شروع یک اسکچ',
    howItWorks: 'چطور کار می‌کند',
    steps: {
      tempo: { title: 'ضرب را تنظیم کن', body: 'با همان سرعتی که در ذهن داری تپ کن.' },
      record: { title: 'ضبط کن', body: 'یک میزان شمارش می‌شنوی، بعد تا شصت ثانیه وقت داری.' },
      hear: { title: 'گوش کن', body: 'یک ساز انتخاب کن و میزان تمیزی را تنظیم کن.' },
    },
  },

  mode: {
    label: 'چه چیزی می‌خواهی بسازی؟',
    melody: 'یک ملودی',
    melodyHint: 'زمزمه کن یا بخوان.',
    rhythm: 'یک ریتم',
    rhythmHint: 'بیت‌باکس کن.',
    changeWarning: 'با تغییر این گزینه، ضبط فعلی پاک می‌شود.',
  },

  tempo: {
    label: 'سرعت',
    tapPrompt: 'چهار بار با سرعت خودت تپ کن',
    tapMore: (remaining: number) => `${remaining} تای دیگر`,
    tapAgain: 'دوباره تپ کن',
    unit: 'BPM',
    sliderLabel: 'ضرب در دقیقه',
    metronome: 'مترونوم',
    metronomeOn: 'مترونوم روشن',
    metronomeOff: 'مترونوم خاموش',
    meter: 'ضرب در هر میزان',
    why: 'صدای مترونوم زمان‌بندی‌ات را ثابت نگه می‌دارد. همه‌ی مراحل بعدی به آن وابسته‌اند.',
  },

  record: {
    arm: 'ضبط',
    countdown: 'آماده باش',
    countIn: (beat: number) => `${beat}`,
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

  review: {
    title: 'اسکچ تو',
    play: 'پخش',
    pause: 'مکث',
    restart: 'برگشت به ابتدا',
    cleanup: 'تمیزکاری',
    cleanupHelp: 'یک سر، دقیقاً همان چیزی است که خواندی. سر دیگر، کاملاً تمیز شده.',
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
    analysis: {
      range: 'دامنه',
      detectedTempo: 'سرعت شنیده‌شده',
      yourTempo: 'سرعت تو',
      octaveFixes: 'پرش‌های اکتاوی حذف‌شده',
      snapped: 'نت‌های منتقل‌شده به گام',
      merged: 'تکه‌های ادغام‌شده',
      stepwise: 'حرکت پله‌ای',
      tempoMismatch: 'این با سرعتی که تپ کردی فرق دارد. اگر نتیجه درست حس نمی‌شود، دوباره تپ کن.',
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
    loadFailed: 'این ساز بارگذاری نشد.',
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
    wav: 'فایل صوتی',
    wavHint: 'یک فایل WAV که هرجا پخش می‌شود و می‌توانی برای کسی بفرستی.',
    midi: 'فایل نت',
    midiHint: 'یک فایل MIDI که در نرم‌افزارهای موسیقی باز می‌شود.',
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
    audio_silent: 'چیزی ضبط نشد.',
    audio_clipped: 'صدای ضبط‌شده دچار اعوجاج است.',
    audio_too_short: 'این برای کار کردن خیلی کوتاه بود.',
    model_load_failed: 'مدل شنیدن دانلود نشد.',
    transcription_failed: 'ضبط تو به نت تبدیل نشد.',
    transcription_empty: 'در این ضبط نتی پیدا نشد.',
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
    localTitle: 'همه‌چیز روی دستگاه خودت است',
    localBody:
      'ضبط تو در همین مرورگر پردازش می‌شود. تا وقتی منتشر نکنی، جایی فرستاده نمی‌شود.',
    uploadTitle: 'این مرحله صدا را آپلود می‌کند',
    processedBy: (backend: string) => `پردازش‌شده با: ${backend}`,
    backends: {
      'basic-pitch': 'مدل نت، در مرورگر تو',
      'pitch-tracker': 'ردیاب زیروبمی داخلی، در مرورگر تو',
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
