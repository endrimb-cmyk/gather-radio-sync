# 044 Radio 3.0 — Google login + пошук + спільний ефір у Gather V2

Це оновлення до попереднього `gather-radio-sync` для Firebase-проєкту `music-c1336`.

## Що працює в цій версії

- Ведучий входить через **Google Sign-in** у Firebase Authentication. Сесія зберігається через `browserLocalPersistence` до виходу, очищення даних сайту або зміни політик браузера.
- Ведучий шукає музичні відео за назвою через **офіційний YouTube Data API v3**; можна вибирати доступні YouTube-плейлисти свого акаунта.
- Google-акаунт, який створив кімнату, є єдиним ведучим цієї кімнати; контроль перевіряється **Firebase Realtime Database Rules**, а не лише кнопками інтерфейсу.
- Інші люди можуть зайти за посиланням **без Google-входу** та натиснути **«Приєднатися»**; вони слухають той же момент композиції приблизно синхронно.
- Назву, канал/виконавця, обкладинку, статус і приблизну позицію композиції видно навіть без приєднання. Для прослуховування використовується **видимий офіційний YouTube-плеєр**.
- Кнопки Play/Pause/Next/Seek доступні ведучому, слушачу — тільки приєднання/від'єднання та локальна гучність.

## Важливі обмеження

1. Це **не вхід у повний інтерфейс YouTube Music**. Google OAuth + YouTube Data API не дає повного доступу до музичної бібліотеки, преміум-програвання, рекомендацій і всіх спеціальних плейлистів YouTube Music. Власні плейлисти — саме ті, що доступні через YouTube Data API.
2. YouTube забороняє відокремлювати аудіо від відео та приховувати офіційний відеоплеєр під час програвання. Тому «лише звук без відео» з джерела YouTube тут не реалізовано.
3. Користувач зберігає **Firebase-сесію Google** між візитами. Короткочасний OAuth токен YouTube Data API **не зберігається** у localStorage (з міркувань безпеки). Після перезавантаження для пошуку/плейлистів натисни «Підключити YouTube-каталог» та підтвердь доступ, якщо він потрібен. Керування вже вибраним треком не вимагає цього токена.
4. Наявний ефір, створений попередньою версією **анонімним DJ**, не стане автоматично підконтрольним Google-акаунту. У V3 створи **нову кімнату** після Google-входу й заміни посилання на неї в Gather.
5. Браузери блокують автозапуск звуку; після приєднання іноді треба натиснути Play в офіційному плеєрі. Вбудоване в Gather вікно може блокувати Google popup/cookies; входь у **звичайній вкладці браузера**.
6. Деякі YouTube-відео і плейлисти забороняють embed або недоступні за регіоном. Для приватних YouTube-плейлистів embedded playback може не працювати; в інтерфейсі вони недоступні для вибору.

## Підключення Firebase (існуючий проект 044 Music)

1. **Firebase Console → 044 Music → Security → Authentication → Sign-in method**. Залиши `Anonymous` увімкненим і **увімкни `Google`**. Збережи.
2. **Authentication → Settings → Authorized domains**: додай `endrimb-cmyk.github.io` (без `https://` та без шляху `/gather-radio-sync`). Ім'я домену має збігатися з фактичним доменом GitHub Pages.
3. **Realtime Database → Rules**: встав **весь вміст** `database.rules.json` із цього архіву, натисни **Publish**. Ці правила дозволяють анонімне читання власникам посилання (із Firebase auth), але **запис — тільки Google-ведучому** кімнати. Не роби `.write: true`.
4. `config.js` уже містить публічну клієнтську конфігурацію **music-c1336**, інших ключів чи секретів не потрібно.

## Увімкни YouTube Data API v3

1. Відкрий https://console.cloud.google.com/apis/library/youtube.googleapis.com
2. Вибери **той самий Google Cloud project**, що відповідає Firebase `music-c1336` (ідентифікатор проєкту), натисни **Enable**.
3. Перевір Google Auth Platform / OAuth consent screen: назва застосунку, контактний email, **Audience**. Для тестового зовнішнього застосунку додай Google email ведучого в **Test users**, якщо система цього вимагає. Дозвіл, який застосунок просить: `https://www.googleapis.com/auth/youtube.readonly` (лише читання YouTube-акаунта).
4. У деяких проєктах додатково потрібно налаштувати branding/OAuth consent. Для широкого публічного використання чутливих scopes Google може вимагати перевірку застосунку. Для внутрішнього тесту використовуй дозволені тестові акаунти.
5. YouTube Data API має квоту. Зокрема `search.list` коштує **100 units** за запит, тому не роби безперервний автопошук при кожному введеному символі. У цій версії пошук запускається лише кнопкою / Enter.

## Оновлення GitHub Pages

1. Розпакуй ZIP. У репозиторії `https://github.com/endrimb-cmyk/gather-radio-sync` заміни старі файли `index.html`, `app.js`, `config.js`, `database.rules.json`, `README.md` на файли з цього архіву; також переконайся, що `.nojekyll` є у корені.
2. Після **Commit changes** GitHub Pages оновить сайт. У Settings → Pages має залишатися **Deploy from a branch → main → /(root)**.
3. Відкрий **https://endrimb-cmyk.github.io/gather-radio-sync/** у звичайній вкладці, натисни **«Увійти через Google»**, вибери акаунт, дозволь доступ YouTube, **«Створити ефір»**.
4. Скопіюй **новий URL кімнати** з `?room=...` та встав його в Interactive Object у Gather V2.
5. Перевір із другого браузера: відкрий URL як гість → «Приєднатися» → за потреби Play у YouTube. Ведучий перемикає трек — у слухача змінюється назва, обкладинка й синхронізується відтворення.

## Налагодження

| Помилка | Що перевірити |
|---|---|
| `auth/operation-not-allowed` | Firebase Authentication → Sign-in method → Google і Anonymous |
| `auth/unauthorized-domain` | Firebase → Authentication → Settings → Authorized domains → `endrimb-cmyk.github.io` |
| `access_denied` / `app not verified` | OAuth consent screen → Audience → Test users + дозволи |
| `YouTube Data API has not been used in project...` | API Library → YouTube Data API v3 → Enable в **music-c1336** |
| `Permission denied` при створенні кімнати | Realtime Database → Rules → Publish **нові правила V3**; Google login має бути дійсним |
| `quotaExceeded` | Ліміт запитів YouTube API, перевір quota в Google Cloud |
| `popup-blocked` у Gather | Відкрити GitHub Pages у звичайній вкладці браузера |
| Відео не програється / YouTube error 153 | Немає коректного контексту embed/referrer або відео забороняє embedding; спробуй іншу пісню або звичайну вкладку |

Технічна примітка: перевірено синтаксис JavaScript та JSON. Живі Google OAuth, Firebase та YouTube виклики потребують налаштування сервісів на твоєму акаунті й окремого тестування.

Офіційна документація:
- Firebase Google sign-in: https://firebase.google.com/docs/auth/web/google-signin
- Firebase Auth persistence: https://firebase.google.com/docs/auth/web/auth-state-persistence
- YouTube Data API: https://developers.google.com/youtube/data/guides/implementation/playlists
- YouTube developer policies: https://developers.google.com/youtube/terms/developer-policies/
