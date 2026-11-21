// יוצר זוג מפתחות VAPID ל-Web Push ושומר ב-.vapid.json (לא נכנס ל-git).
// המפתח הציבורי נכתב ל-public/config.js, הפרטי עולה ל-Supabase כ-secret.
import webpush from "web-push";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const file = new URL("../.vapid.json", import.meta.url);
let keys;
if (existsSync(file)) {
  keys = JSON.parse(readFileSync(file, "utf8"));
  console.log("Using existing .vapid.json");
} else {
  keys = webpush.generateVAPIDKeys();
  writeFileSync(file, JSON.stringify(keys, null, 2));
  console.log("Created .vapid.json");
}
console.log("VAPID_PUBLIC_KEY=" + keys.publicKey);
