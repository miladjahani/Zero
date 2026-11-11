# روش استقرار پنل ZEUS روی کلودفلر

این سند همان روشی است که با آن پنل زئوس واقعاً مستقر و تست شد (نمونهٔ زنده: `mil-zeus` → `https://mil-zeus.pelican-guru-slick.workers.dev` با پاسخ `200`).

هرچه در بخش «آنچه موتور انجام می‌دهد» آمده از لاگ واقعی یک استقرار موفق است، و هرچه در بخش «روش دستی» آمده همان تنظیماتی است که روی ورکر مستقرشده دیده شد.

---

## ۱) پنل زئوس چیست و چه چیزی مستقر می‌شود

| مورد | مقدار |
|---|---|
| فایل پنل | `Source.js` از مخزن [`panel-zeus/Z-E-U-S`](https://github.com/panel-zeus/Z-E-U-S) |
| آدرس خام | `https://raw.githubusercontent.com/panel-zeus/Z-E-U-S/main/Source.js` |
| نوع | پنل کامل مبتنی بر **D1** (نه ورکر ساب‌محور) |
| داشبورد | روی **ریشهٔ** ورکر (`/`)؛ `/admin` ندارد |
| لینک ساب آماده در زمان استقرار | **ندارد** — ساب هر کاربر داخل خود پنل ساخته می‌شود |
| نشانهٔ هویت فایل | رشتهٔ `GLOBAL_TRAFFIC_CACHE` (اگر در فایل نباشد، فایل اشتباه است و نباید آپلود شود) |
| تاریخ سازگاری | `2026-07-10` |
| فلگ‌های سازگاری | `nodejs_compat`, `global_fetch_strictly_public` |
| KV | لازم نیست (پنل D1-محور است) |
| بایندینگ‌های واقعی روی ورکر مستقرشده | `DB` (D1) · `CF_ACCOUNT_ID` · `CF_API_TOKEN` · `WORKER_NAME` · `WIZARD_URL` |

جدول‌های D1 که پنل انتظار دارد: `users` و `settings` (به‌همراه ستون‌های اضافه‌شده با `ALTER TABLE`). پنل خودش در اولین درخواست `ensureSchema` می‌زند، ولی اگر از قبل seed شود، اولین بازدید کاربر با دیتابیس خالی مسابقه نمی‌دهد و خطای `error code: 1101` رخ نمی‌دهد.

---

## ۲) پیش‌نیازها

**الف) توکن کلودفلر** با دسترسی‌های زیر:

| دسترسی | برای چه |
|---|---|
| Workers Scripts: **Read + Edit** | ساخت/آپلود اسکریپت، فعال‌کردن مسیر `workers.dev` |
| D1: **Read + Edit** | ساخت دیتابیس و اجرای schema |
| Workers KV Storage: Read + Edit | فقط اگر منبعی KV بخواهد (زئوس نمی‌خواهد) |
| Workers R2: Read + Edit | اختیاری؛ اگر R2 در حساب **فعال نشده** باشد همان اول با پیام روشن رد می‌شود و استقرار ادامه می‌یابد |
| Account Settings: **Read** | لیست اکانت‌ها؛ برای توکن‌های Account-owned (پیشوند `cfat_`) این تنها راه تشخیص حساب است، چون `/user/tokens/verify` آن‌ها را رد می‌کند |
| Zone / Zone Settings / DNS / SSL | فقط برای وصل‌کردن **دامنهٔ شخصی** |

**ب)** حساب باید زیردامنهٔ `workers.dev` داشته باشد، وگرنه آدرس ورکر و لینک‌ها کامل نمی‌شوند.

**پ) نکتهٔ مهم برای ایران:** دامنهٔ `*.workers.dev` در ایران مسدود است؛ پنل و کانفیگ با آن **بدون فیلترشکن** باز نمی‌شود. برای استفادهٔ واقعی یک **Custom Domain** به ورکر وصل کنید (تنظیمات Cloudflare → Workers → ورکر → Custom Domains). خودِ ورکر سالم است؛ فقط دامنه سانسور می‌شود.

**ت)** محدودیت اجرای هم‌زمان: هر invocation ورکر روی پلن رایگان فقط **۵۰ subrequest** دارد. موتور استقرار در همان invocation کار می‌کند، پس مراحل شبکه‌ای باید کم و دسته‌ای باشند (بخش ۳).

---

## ۳) روش اول (توصیه‌شده): استقرار از پنل میلی‌کانفیگ

1. وارد پنل شو و از بخش **توکن‌ها** توکن کلودفلر را ثبت کن.
2. **استقرار جدید** → نام ورکر (مثلاً `mil-zeus`) → منبع ورکر را **ZEUS PANEL (panel-zeus/Z-E-U-S)** انتخاب کن → متد **Workers** → UUID بده.
3. استقرار در همان لحظه شروع می‌شود و لاگ زنده دارد.

### آنچه موتور انجام می‌دهد (به همین ترتیب، از لاگ یک استقرار موفق)

```
verifying token...
ℹ user-token verify declined — checking account access instead (expected for Account API tokens)
listing accounts...
✓ token can deploy (account access confirmed)
✓ account: <نام اکانت>
fetching worker source from ZEUS PANEL (panel-zeus/Z-E-U-S)...
✓ worker source fetched (<n> bytes) — checksum verified against upstream main   ← هویت و چک‌سام
creating D1 database...
✓ D1 database ready: <uuid>
creating KV namespace...                                                        ← برای زئوس لازم نیست
creating R2 bucket...                                                           ← اگر خاموش باشد: هشدار و ادامه
seeding zeus D1 schema (users/settings tables)…
✓ zeus D1 schema ready (n statements applied)
uploading worker script...
✓ worker script uploaded
re-creating the new script (Cloudflare can leave a first creation dead)…
✓ script re-created cleanly
enabling workers.dev route for script...
✓ workers.dev route enabled
reading workers.dev subdomain...
✓ worker URL: https://<name>.<subdomain>.workers.dev
✓ panel URL: https://<name>.<subdomain>.workers.dev
warming up worker (waiting for first live response)…
✓ worker is live — first request answered without 1101
✓ Smart Placement ON (worker co-located with D1)
✓ deployment complete!
```

### دو تلهٔ واقعی که استقرار را می‌کشند

1. **بودجهٔ subrequest:** اجرای ۳۷ استیتمنت schema به‌صورت ۳۷ فراخوانی جدا، کل بودجهٔ ۵۰تایی را می‌خورد و استقرار **بعد از آپلود موفق** در مرحلهٔ `enabling workers.dev route` با این خطا می‌مرد:
   `Too many subrequests by single Worker invocation`.
   راه درست: استیتمنت‌ها را **دسته‌ای** (یک یا دو فراخوانی چنداستیتمنتی) اجرا کن. D1 چند استیتمنت را در یک `sql` می‌پذیرد و برای هرکدام یک ورودی در `result[]` برمی‌گرداند، ولی **همه‌یا‌هیچ** است: یک خطا یعنی کل batch رد می‌شود (برای `ALTER TABLE` تکراری، همین حالت «قبلاً هست» است و مشکلی نیست).
2. **BOM در فایل منبع:** اگر فایل با BOM (`EF BB BF`) شروع شود و کد با `resp.text()` خوانده شود، BOM طبق استاندارد حذف می‌شود و طول/هش محاسبه‌شده با `size` رسمی گیت‌هاب نمی‌خواند → استقرار با «چک‌سام مطابقت ندارد» رد می‌شود. راه درست: خواندن بایت‌به‌بایت (`TextDecoder('utf-8', { ignoreBOM: true })` روی `arrayBuffer()`). (این تله روی `cmliu/edgetunnel` عملاً پیش آمد؛ برای زئوس هم بی‌ضرر و لازم است.)

---

## ۴) روش دوم (دستی با wrangler)

```bash
# ۱) دیتابیس D1
npx wrangler d1 create zeus-panel-db          # uuid را از خروجی بردار

# ۲) فایل پنل
curl -L -o Source.js https://raw.githubusercontent.com/panel-zeus/Z-E-U-S/main/Source.js
```

`wrangler.toml`:

```toml
name = "mil-zeus"
main = "Source.js"
compatibility_date = "2026-07-10"
compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]

[[d1_databases]]
binding = "DB"
database_name = "zeus-panel-db"
database_id = "<uuid از مرحلهٔ ۱>"

[vars]
WORKER_NAME = "mil-zeus"
WIZARD_URL = ""
```

```bash
# ۳) schema (idempotent) — با فایل SQL یا استیتمنت‌های ZEUS_SCHEMA_STATEMENTS در worker/deploy.ts
npx wrangler d1 execute zeus-panel-db --remote --file=zeus-schema.sql

# ۴) استقرار
npx wrangler deploy

# ۵) اگر مسیر workers.dev خاموش است، روشنش کن
curl -X POST "https://api.cloudflare.com/client/v4/accounts/<account_id>/workers/scripts/mil-zeus/subdomain" \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' -d '{"enabled":true}'
```

سپس آدرس `https://mil-zeus.<your-subdomain>.workers.dev` را باز کن؛ اولین بازدید، ویزارد ساخت مدیر را نشان می‌دهد.

---

## ۵) چک‌لیست پس از استقرار (همه را واقعاً تست کن)

```bash
S=<subdomain>; N=mil-zeus
curl -4 -s -o /dev/null -w "root: %{http_code}\n"  "https://$N.$S.workers.dev/"          # انتظار: 200
curl -4 -s -o /dev/null -w "host: %{http_code}\n"  "https://$N.$S.workers.dev/anything" # نباید 1101 بدهد
```

| بررسی | ابزار | انتظار |
|---|---|---|
| اسکریپت مستقر شده | `GET /accounts/{acc}/workers/scripts` | نام ورکر در لیست |
| بایندینگ‌ها | `GET .../scripts/{name}/settings` | `DB` + `CF_ACCOUNT_ID` + `CF_API_TOKEN` + `WORKER_NAME` + `WIZARD_URL` |
| جدول‌ها | `POST /accounts/{acc}/d1/database/{uuid}/query` با `SELECT name FROM sqlite_master` | `users`, `settings` |
| مسیر workers.dev | `GET .../scripts/{name}/subdomain` | `enabled: true` |
| زنده بودن | درخواست HTTP به ریشه | `200` + HTML (نه `error code: 1101`) |
| ورود مدیر | خود پنل | ویزارد ساخت مدیر روی `/` کار کند |

---

## ۶) عیب‌یابی سریع

| نشانه | معنا | راه‌حل |
|---|---|---|
| `error code: 1101` روی همهٔ مسیرها | استثنای داخلی اسکریپت — معمولاً بایندینگ گم‌شده، جدول نبودِ D1، یا کانفیگ ناقص | بایندینگ‌ها را با settings بسنج، schema را seed کن، لاگ زمان اجرا (Workers Logs) را ببین |
| `error code: 1101` روی **همهٔ** ورکرها — حتی یک «hello world» تازه — و `wrangler tail` هیچ invocation نشان نمی‌دهد (ولی همان حساب Pages را درست سرو می‌کند) | حساب کلودفلر تازه است و Workers در آن هنوز فعال/provision نشده؛ کد و بایندینگ بی‌تقصیرند (آپلود موفق است، درخواست هرگز به isolate نمی‌رسد) | یک‌بار با همان حساب وارد داشبورد شو: Workers & Pages → Get started (همین بازدید اول، فعال‌سازی حساب را تمام می‌کند)، بعد درخواست را دوباره بزن. تا آن لحظه پنل را روی **Pages** بالا بیاور که در همین حساب کار می‌کند |
| `error code: 1042` | این نام روی `workers.dev` مسیر ندارد (یا اسکریپت ساخته نشده) | مرحلهٔ `.../subdomain {enabled:true}` را اجرا کن |
| `database not found` | `database_id` در کانفیگ به اکانت/دیتابیس دیگری اشاره می‌کند | uuid واقعی همان اکانت را بگذار |
| `Please enable R2 through the Cloudflare Dashboard` | R2 در حساب فعال نیست | از داشبورد فعال کن یا بی‌خیال شو (استقرار ادامه می‌یابد) |
| `Too many subrequests by single Worker invocation` | بودجهٔ ۵۰ subrequest | seed را دسته‌ای کن، مراحل شبکه‌ای را کم کن |
| «چک‌سام فایل دانلودشده با نسخهٔ منتشرشده مطابقت ندارد» | فایل ناقص دانلود شده **یا** مشکل BOM | بایت‌به‌بایت بخوان (`ignoreBOM: true`) و دوباره امتحان کن |
| `a namespace with this account ID and title already exists` | KV با همان عنوان از قبل هست | namespace موجود را بازاستفاده کن (یا قبلی را حذف کن) |
| `Your Pages project has been blocked … [code: 8000119]` | بلاک سمت کلودفلر روی یک پروژهٔ Pages | پروژهٔ تازه بساز یا با `abusereply@cloudflare.com` مکاتبه کن؛ به کانفیگ ربطی ندارد |

---

## ۷) منابع

- تعریف منبع زئوس در همین مخزن: `worker/deploy.ts` → `WORKER_SOURCES.zeus` (آدرس، تاریخ سازگاری، فلگ‌ها، `expectMarker: 'GLOBAL_TRAFFIC_CACHE'`)
- اسکیمای seed: `ZEUS_SCHEMA_STATEMENTS` در `worker/deploy.ts`
- اعتبارسنجی منبع: `worker/source-verify.ts`
- سورس پنل: [`panel-zeus/Z-E-U-S`](https://github.com/panel-zeus/Z-E-U-S) (`Source.js`, `README.fa.md`)
- الگوریتم اصلاح ربات تلگرام (بدون مینی‌پنل): [`zeus-bot-algorithm.md`](./zeus-bot-algorithm.md)
