# משימות שלנו

אפליקציה משותפת לשני אנשים: משימות ומבחנים, עם התראות לאייפון.

**כתובת:** https://elddad.github.io/task-for-two/

## מה יש בה

- **משימות** עם רמת דחיפות (נמוכה / רגילה / גבוהה / דחוף), תאריך תפוגה, תזכורת, ו"להציק אם לא בוצע אחרי X ימים".
- **משימות קבועות** 🔁: כל יום / כל X ימים / כל שבוע בימים שבוחרים / כל חודש. כשמסמנים שבוצעה, נוצרת אוטומטית הפעם הבאה עם אותם משויכים, והתפוגה והתזכורת זזות בהתאם (לפי שעון ישראל). מועדים שהוחמצו מדלגים עליהם – הפעם הבאה תמיד בעתיד.
- **מי מבצע**: אני / השני / שנינו – מי שיספיק (מספיק שאחד מסמן) / שנינו – כל אחד (נסגרת רק כששניכם סימנתם).
- **מבחנים**: מקצוע, תאריך, שעה, של מי, הערות. ספירה לאחור, ומבחנים שעברו מוסתרים.
- **התראות Push** (גם כשהאפליקציה סגורה):
  - כשהשני מוסיף משימה או מבחן, או מסמן משימה כבוצעה
  - בזמן התזכורת של משימה
  - 24 שעות לפני שמשימה פגה (ושעה לפני, למשימות גבוהות/דחופות)
  - כשמשימה פגה ולא בוצעה
  - כשמשימה לא בוצעה כמה ימים (רק בין 9:00 ל-21:00)
  - בערב שלפני מבחן (20:00)
- עדכון חי: מה שאחד מוסיף מופיע מיד אצל השני.

## איך זה בנוי

| חלק | איפה |
|---|---|
| האתר (HTML/CSS/JS, בלי build) | `public/` – מתארח בחינם ב-GitHub Pages |
| מסד נתונים, התחברות, עדכון חי | Supabase (חינם) – `supabase/migrations/` |
| שליחת התראות | Supabase Edge Functions – `supabase/functions/notify` (מיידי), `supabase/functions/cron-check` (כל 5 דקות דרך `pg_cron`) |
| Push | Web Push עם מפתחות VAPID. המפתח הפרטי נמצא רק ב-`.vapid.json` (לא ב-git) וב-secrets של Supabase |

האפליקציה מוגבלת לשני משתמשים: מי שינסה להירשם שלישי יקבל שגיאה.

## הקמה (פעם אחת)

1. ב-[supabase.com](https://supabase.com) פותחים פרויקט חינמי.
2. ב-Supabase: **Authentication → Sign In / Providers → Email** – מכבים את **Confirm email** (אחרת צריך לאשר מייל לפני כניסה).
3. ממלאים את `public/config.js` (Project URL ו-anon/publishable key מ-**Project Settings → API**).
4. מהתיקייה הזו:
   ```
   npm install
   npx supabase login
   npx supabase link --project-ref <PROJECT_REF>
   npx supabase db push
   npm run vapid
   npx supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=https://elddad.github.io/task-for-two
   npm run functions:deploy
   ```
5. המיגרציה `..._config.sql` שומרת במסד את כתובת הפונקציות (`https://<PROJECT_REF>.supabase.co/functions/v1`).
6. מעלים את `public/` ל-GitHub Pages (יש workflow ב-`.github/workflows/pages.yml`).

## התקנה באייפון

1. פותחים את https://elddad.github.io/task-for-two/ ב-**Safari**.
2. כפתור **שיתוף** → **הוספה למסך הבית**.
3. פותחים את האפליקציה מהאייקון, נרשמים/נכנסים.
4. **הגדרות → הפעלת התראות** → מאשרים.

צריך iOS 16.4 ומעלה. בלי ההוספה למסך הבית אייפון לא שולח התראות לאתרים.

## בדיקה מקומית

```
npm run serve        # http://localhost:5173 (או: node scripts/serve.mjs 5391)
```

הרצה ידנית של בדיקת ההתראות המתוזמנות:

```
curl -X POST https://<PROJECT_REF>.supabase.co/functions/v1/cron-check
```

הקריאה בטוחה: כל התראה נשלחת פעם אחת בלבד, אז קריאה נוספת לא תשלח כפילויות.
