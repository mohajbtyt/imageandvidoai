'use strict';
// Every user-facing error has a stable code plus Arabic and English messages.
const CATALOG = {
  NOT_CONFIGURED_IMAGE: [503, 'Image enhancement is not configured on this server (the AI service key is missing).', 'تحسين الصور غير مهيأ على هذا الخادم (مفتاح خدمة الذكاء الاصطناعي مفقود).'],
  NOT_CONFIGURED_VIDEO: [503, 'Video enhancement is not configured on this server (video engine disabled or API key missing).', 'تحسين الفيديو غير مهيأ على هذا الخادم (محرك الفيديو معطّل أو مفتاح API مفقود).'],
  VIDEO_TOOLS_MISSING: [503, 'Video enhancement is unavailable: ffprobe/ffmpeg is not installed on the server, so videos cannot be verified.', 'تحسين الفيديو غير متاح: أداة ffprobe/ffmpeg غير مثبتة على الخادم فلا يمكن التحقق من الفيديو.'],
  INVALID_PARAMS: [400, 'Invalid request parameters.', 'معاملات الطلب غير صالحة.'],
  UNSUPPORTED_TYPE: [415, 'Unsupported file type. Images: JPG, PNG, WebP. Video: MP4.', 'نوع الملف غير مدعوم. الصور: JPG وPNG وWebP. الفيديو: MP4.'],
  FILE_TOO_LARGE: [413, 'The file exceeds the maximum allowed size.', 'حجم الملف يتجاوز الحد المسموح.'],
  EMPTY_FILE: [400, 'The file is empty.', 'الملف فارغ.'],
  CORRUPT_FILE: [422, 'The file is corrupt or cannot be read.', 'الملف تالف أو لا يمكن قراءته.'],
  IMAGE_TOO_LARGE_DIMS: [422, 'The image resolution is too high for processing.', 'دقة الصورة أعلى من الحد المسموح للمعالجة.'],
  ANIMATED_IMAGE: [415, 'Animated images are not supported.', 'الصور المتحركة غير مدعومة.'],
  VIDEO_TOO_LONG: [422, 'The video must be shorter than 10 seconds.', 'يجب أن تكون مدة الفيديو أقل من 10 ثوانٍ.'],
  VIDEO_NO_STREAM: [422, 'No playable video stream was found in the file.', 'لم يتم العثور على مسار فيديو صالح في الملف.'],
  VIDEO_TOO_LARGE_DIMS: [422, 'The video resolution is too high for processing.', 'دقة الفيديو أعلى من الحد المسموح للمعالجة.'],
  RESOLUTION_NOT_HIGHER: [422, 'The chosen target resolution is not higher than the source video. Choose a higher level.', 'الدقة المستهدفة ليست أعلى من دقة الفيديو الأصلي. اختر مستوى أعلى.'],
  ACCESS_DENIED: [401, 'Access code required or incorrect.', 'رمز الدخول مطلوب أو غير صحيح.'],
  RATE_LIMITED: [429, 'Too many requests. Please try again later.', 'طلبات كثيرة جدًا. حاول مرة أخرى لاحقًا.'],
  BUSY: [429, 'You already have a job running, or the server is busy. Please wait for it to finish.', 'لديك معالجة قيد التنفيذ أو أن الخادم مشغول. انتظر حتى تنتهي.'],
  DAILY_LIMIT: [429, 'The daily processing limit of this server has been reached. Try again tomorrow.', 'تم بلوغ الحد اليومي للمعالجة على هذا الخادم. حاول غدًا.'],
  NOT_FOUND: [404, 'Not found (it may have expired and been deleted).', 'غير موجود (ربما انتهت صلاحيته وتم حذفه).'],
  NOT_READY: [409, 'The result is not ready yet.', 'النتيجة ليست جاهزة بعد.'],
  REPLICATE_AUTH: [502, 'The AI service rejected the API key. Check the server configuration.', 'خدمة الذكاء الاصطناعي رفضت مفتاح API. تحقق من إعدادات الخادم.'],
  REPLICATE_BILLING: [502, 'The AI service account has insufficient credit.', 'رصيد حساب خدمة الذكاء الاصطناعي غير كافٍ.'],
  REPLICATE_RATE: [502, 'The AI service is rate-limiting requests. Try again shortly.', 'خدمة الذكاء الاصطناعي تحدّ من الطلبات حاليًا. حاول بعد قليل.'],
  REPLICATE_INVALID_INPUT: [502, 'The AI service rejected the input.', 'خدمة الذكاء الاصطناعي رفضت المُدخل.'],
  UPSTREAM_UNAVAILABLE: [502, 'The AI service is unreachable or returned an unexpected error.', 'تعذّر الوصول إلى خدمة الذكاء الاصطناعي أو أعادت خطأ غير متوقع.'],
  PROCESSING_FAILED: [502, 'The AI model failed to process this file.', 'فشل نموذج الذكاء الاصطناعي في معالجة هذا الملف.'],
  PROCESSING_TIMEOUT: [504, 'Processing took too long and was cancelled.', 'استغرقت المعالجة وقتًا طويلًا وتم إلغاؤها.'],
  BAD_OUTPUT: [502, 'The AI service returned an invalid result file.', 'أعادت الخدمة ملف نتيجة غير صالح.'],
  OUTPUT_HOST_BLOCKED: [502, 'The result was served from a host that is not allowed.', 'النتيجة قُدّمت من مضيف غير مسموح به.'],
  OUTPUT_DOWNLOAD_FAILED: [502, 'Could not download the result from the AI service.', 'تعذّر تنزيل النتيجة من خدمة الذكاء الاصطناعي.'],
  INTERNAL: [500, 'Internal server error.', 'خطأ داخلي في الخادم.'],
};

class AppError extends Error {
  constructor(code, detail) {
    super(code);
    const entry = CATALOG[code] || CATALOG.INTERNAL;
    this.code = CATALOG[code] ? code : 'INTERNAL';
    this.status = entry[0];
    this.en = entry[1];
    this.ar = entry[2];
    this.detail = detail ? String(detail).slice(0, 300) : undefined;
  }
  toJSON() {
    return { code: this.code, message_en: this.en, message_ar: this.ar, detail: this.detail };
  }
}

module.exports = { AppError, CATALOG };
