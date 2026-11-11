# الگوریتم اصلاح ربات تلگرام زئوس — «بدون مینی‌پنل»

> این سند را می‌توانی عیناً برای صاحب مخزن زئوس بفرستی. هدف: ربات تلگرام گروه زئوس **مینی‌پنل (Mini App / WebApp) نداشته باشد و به آن نیازی نداشته باشد**؛ همهٔ کارها داخل خود چت انجام شود.

## ۰) یافتهٔ پایه (قبل از هر تغییر، خودت تأیید کن)

بررسی مخزن `panel-zeus/Z-E-U-S` نشان می‌دهد فایل پنل (`Source.js`) **هیچ کد تلگرامی و هیچ `WebApp`/`web_app`/`menu_button` ندارد**:

```
Source.js  → "api.telegram.org": 0   "callback_data": 0   "web_app": 0
             "WebAppInfo": 0         "menu_button": 0     "initData": 0
```

پس سطح «مینی‌پنل» (اگر جایی وجود دارد) در **کد ربات دیپلوی** است (همان `@ZEUS_PANEL_BOT`)، و مدل درست همان مدلی است که `README.fa.md` توصیف می‌کند: ثبت اکانت، گرفتن توکن، فرستادن توکن در چت، ساخت پنل — **کاملاً داخل چت**.

---

## ۱) قواعد ثابت (این پنج مورد نباید هیچ‌کجا نقض شوند)

| # | قاعده | دلیل |
|---|---|---|
| ۱ | هیچ دکمهٔ `web_app` ساخته نشود؛ دکمه‌ها فقط `callback_data` یا `url` باشند | با حذف مینی‌پنل، `web_app` خطای «Button type is not supported» یا بی‌واکنش می‌دهد |
| ۲ | `setChatMenuButton` هرگز با `menu_button: { type: "web_app" }` صدا زده نشود | منوی ربات نباید کاربر را به مینی‌پنل ببرد |
| ۳ | هیچ فلوی اجباری «اول پنل کوچک را باز کن» وجود نداشته باشد | کاربر گروه اصلاً مینی‌پنل ندارد |
| ۴ | اعتبارسنجی `initData` (HMAC) و مسیرهای `/newapp`/`answerWebAppQuery` حذف شوند | بدون مینی‌پنل هیچ `initData` معتبری نمی‌آید |
| ۵ | خروجی‌ها (ساب/کانفیگ/QR) به‌صورت **متن یا فایل در چت** ارسال شوند | همین چیزی است که کاربر لازم دارد |

---

## ۲) الگوریتم (گام‌به‌گام)

```
ALGORITHM fix_bot_without_mini_app(bot_source):

  # ── گام ۰: سطح‌یابی ───────────────────────────────────────────────
  hits ← grep(bot_source, [
      "web_app", "WebAppInfo", "MenuButtonWebApp", "KeyboardButton.web_app",
      "setChatMenuButton", "answerWebAppQuery", "web_app_data",
      "initData", "initDataUnsafe", "MiniApp", "newapp", "WebApp.init"
  ])
  اگر hits خالی بود: پایان (ربات از قبل مینی‌پنل ندارد؛ فقط مستندسازی گام ۷)

  # ── گام ۱: دکمه‌های inline ────────────────────────────────────────
  برای هر دکمه از نوع web_app:
      اگر مقصد فقط «خواندنی» است و خارج از تلگرام است:
          → { text, url: "<همان آدرس>" }        # لینک معمولی، بدون WebApp
      وگرنه (عملیات داخل ربات):
          → { text, callback_data: "<action>:<params>" }

  # ── گام ۲: منوی ربات ─────────────────────────────────────────────
  اگر setChatMenuButton(menu_button.type == "web_app") وجود دارد:
      → setChatMenuButton({ menu_button: { type: "commands" } })
        یا در BotFather: /mybots → Bot Settings → Menu Button → خاموش
      → در BotFather بخش Mini App (اگر تنظیم شده) پاک شود

  # ── گام ۳: هندلرها ───────────────────────────────────────────────
  حذف handler مخصوص web_app_data
  برای هر عملِ مینی‌پنل، یک معادل callback_query بساز که همان کار را انجام دهد
  اگر قبلاً answerWebAppQuery استفاده می‌شد → جایگزین: editMessageText/sendMessage

  # ── گام ۴: احراز هویت ────────────────────────────────────────────
  حذف مسیر اعتبارسنجی initData/HMAC و هر middleware وابسته به آن
  هویت کاربر فقط از ctx.from.id (و جدول خودت) تأمین شود

  # ── گام ۵: فلوی توکن کلودفلر (باید کاملاً در چت باشد) ─────────────
  sendMessage("➕ Register Cloudflare Account")
      → دکمهٔ url به صفحهٔ ساخت توکن کلودفلر (بدون WebApp)
      → متن: «توکن را بساز و همین‌جا در چت بفرست»
  دریافت توکن از پیام → اعتبارسنجی با accounts API → ذخیره
      → بلافاصله deleteMessage برای پاک‌کردن پیام حاوی توکن

  # ── گام ۶: خروجی‌ها ──────────────────────────────────────────────
  لینک ساب/کانفیگ → sendMessage با متن یک‌تکه + دکمهٔ کپی ([[code]])
  QR (اختیاری)     → ارسال به‌صورت عکس تولیدشده در خود ربات
  هیچ‌کدام از این‌ها نباید به «باز کردن مینی‌پنل» ارجاع دهند

  # ── گام ۷: سازگاری و مستندسازی ──────────────────────────────────
  اگر کاربران قبلی عادت به دکمه‌های قدیمی دارند، همان callback_dataها را نگه دار
  در README.fa.md بخش «بدون مینی‌پنل» اضافه کن: ربات تمام‌چتی است
```

---

## ۳) تست پذیرش (این‌ها باید واقعاً اجرا و دیده شوند)

```bash
# ۱) هیچ ردی از WebApp در سورس ربات نماند — انتظار: خروجی خالی
grep -rnE "web_app|WebAppInfo|MenuButtonWebApp|initData|answerWebAppQuery|web_app_data" <bot_source_dir>

# ۲) منوی ربات دیگر web_app نباشد — انتظار: type = default یا commands
curl -s "https://api.telegram.org/bot<BOT_TOKEN>/getChatMenuButton" | jq -c '.result.type'

# ۳) دکمه‌های /start — انتظار: هیچ دکمه‌ای web_app نباشد
curl -s "https://api.telegram.org/bot<BOT_TOKEN>/sendMessage" \
  -d chat_id=<CHAT_ID> -d text=/start | jq -c '.result.reply_markup.inline_keyboard'
```

| بررسی | انتظار |
|---|---|
| `grep` بالا | خروجی خالی |
| `getChatMenuButton` | `"default"` یا `"commands"` |
| `/start` در چت | منوی دکمه‌ای کامل، بدون ارجاع به «پنل کوچک» |
| ثبت اکانت + ارسال توکن در چت | ذخیره شود و پیام توکن پاک شود |
| ساخت پنل | D1 + ورکر ساخته شود و لینک در چت بیاید |
| گرفتن ساب | متن/فایل در چت، بدون باز کردن هیچ مینی‌اپی |
| BotFather → Bot Settings | Menu Button و Mini App خاموش/پاک |

---

## ۴) متن آمادهٔ ارسال به صاحب مخزن

> سلام. در مخزن `Z-E-U-S` هیچ کد تلگرامی/WebApp وجود ندارد (بررسی شد: `web_app`, `WebAppInfo`, `menu_button`, `initData` همه صفر)، پس سطح «مینی‌پنل» در کد ربات دیپلوی (`@ZEUS_PANEL_BOT`) است. لطفاً ربات را طوری اصلاح کن که **بدون مینی‌پنل** کامل کار کند؛ چون ربات گروه زئوس مینی‌پنل ندارد و به آن هم نیازی ندارد:
> ۱) دکمه‌های `web_app` → `callback_data` یا `url`.
> ۲) `setChatMenuButton` با `type: "commands"` (یا خاموش از BotFather) و پاک‌کردن Mini App در BotFather.
> ۳) حذف مسیرهای `web_app_data` / `answerWebAppQuery` / اعتبارسنجی `initData`.
> ۴) کل فلو (ثبت اکانت، گرفتن و فرستادن توکن، ساخت پنل، گرفتن ساب) داخل چت با پیام و دکمهٔ اینلاین، و ارسال ساب به‌صورت متن/فایل.
> ۵) در README هم بنویس که ربات نیاز به مینی‌پنل ندارد.
> تست پذیرش: `grep` بدون هیچ `web_app`، `getChatMenuButton` = `commands`، و `/start` کاملاً چتی کار کند.
