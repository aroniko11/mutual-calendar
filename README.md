# היומן של ציפי ואהרון

יומן משותף שרץ כאתר עצמאי (GitHub Pages) ונשמר ב־Supabase. מתקינים אותו באייפון דרך ״הוספה למסך הבית״, והוא שולח התראות גם כשהוא סגור (iOS 16.4 ומעלה).

## מבנה

| קובץ | מה יש בו |
| --- | --- |
| `index.html` | כל האפליקציה: רשימה, חודש, שעון מעורר, טפסים, שיתוף והגדרות |
| `config.js` | כתובת הפרויקט ב־Supabase והמפתח הציבורי (anon / publishable). אף פעם לא את המפתח הסודי |
| `sw.js` | Service worker: פתיחה בלי אינטרנט, קבלת התראות Push ופתיחת האירוע בלחיצה |
| `manifest.webmanifest`, `icons/` | התקנה כאפליקציה במסך הבית |
| `supabase/setup.sql` | טבלאות, הרשאות, תיקיית צרופות פרטית, ותזמון שליחת ההתראות כל דקה |
| `supabase/functions/send-reminders/index.ts` | הפונקציה ששולחת את ההתראות |

## הקמה (פעם אחת)

1. **Supabase:** פותחים פרויקט חדש ב־[supabase.com](https://supabase.com). ב־Project Settings → API מעתיקים את Project URL ואת המפתח `anon` (או `publishable`) ל־`config.js`.
2. **מסד נתונים:** ב־`supabase/setup.sql` מחליפים את `__PROJECT_URL__` בכתובת הפרויקט, ומריצים את כל הקובץ ב־SQL Editor.
3. **פונקציית ההתראות:** Edge Functions → Deploy a new function → Via Editor. השם חייב להיות `send-reminders`. מדביקים את `supabase/functions/send-reminders/index.ts` ולוחצים Deploy. אחר כך, בהגדרות הפונקציה, מכבים את **Verify JWT** (הקריאה מהתזמון נבדקת בסוד משלה).
4. **משתמשים:** Authentication → Users → Add user → Create new user, עם אימייל וסיסמה לכל אחד, ומסמנים Auto Confirm. ב־Authentication → Sign In / Providers מכבים את **Allow new users to sign up**, כדי שרק שניכם תוכלו להיכנס.
5. **האתר:** ב־GitHub, Settings → Pages → Deploy from a branch, בוחרים את הענף ואת התיקייה `/ (root)`. הכתובת תהיה `https://aroniko11.github.io/mutual-calendar/`.

## התקנה באייפון

1. פותחים את כתובת האתר ב־Safari ונכנסים עם האימייל והסיסמה.
2. כפתור השיתוף → ״הוספה למסך הבית״.
3. פותחים את היומן מהאייקון, ⚙ → בוחרים מי משתמש בטלפון → ״הפעלת התראות״ → מאשרים.
4. ״שליחת התראת בדיקה״ מוודאת שהכול עובד.

## מגבלות

- התראת Push מגיעה בצליל הרגיל של הטלפון. הצלצולים המיוחדים והשעון המעורר שמצלצל ברצף עובדים רק כשהיומן פתוח על המסך.
- ההתראות נשלחות פעם בדקה, כך שהן יכולות להגיע עד דקה אחרי המועד.
- במסלול החינמי, Supabase יכול להשהות פרויקט שלא השתמשו בו שבוע. אם זה קורה, נכנסים ללוח הבקרה של Supabase ולוחצים Restore.
