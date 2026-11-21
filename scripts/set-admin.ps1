# Set the app's admin: email + password.
# - If the email already has an account: sets the new password and makes it the admin.
# - If not: creates the admin account with that password.
# The password is typed here only; it is never saved to a file.
# Run from the project folder:  .\scripts\set-admin.ps1

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

$SUPABASE_URL = "https://edxbmfqlueuzewpvfdwb.supabase.co"
$PUBLISHABLE_KEY = "sb_publishable_tmjQeYURBqlednBZYOucTw_Xj3TIf0_"

# SQL goes through a short-lived file (git-ignored folder), so no character in the password can break the command line
function Invoke-Sql([string]$sql) {
  $dir = Join-Path (Get-Location) "supabase\.temp"
  New-Item -ItemType Directory -Force $dir | Out-Null
  $file = Join-Path $dir ("q-" + [guid]::NewGuid().ToString("N") + ".sql")
  try {
    [IO.File]::WriteAllText($file, $sql, [Text.UTF8Encoding]::new($false))
    $out = npx supabase db query --linked --file $file 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "Database error:`n$out" }
    return $out
  } finally {
    Remove-Item $file -Force -ErrorAction SilentlyContinue
  }
}

function Read-Plain([string]$prompt) {
  $sec = Read-Host $prompt -AsSecureString
  return [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}

# ---------------------------------------------------------------- input
$email = (Read-Host "Admin email").Trim().ToLower()
if ($email -notmatch '^[^\s@''$]+@[^\s@''$]+\.[^\s@''$]+$') { throw "That doesn't look like an email address." }

$password = Read-Plain "New password (at least 6 characters)"
if ($password.Length -lt 6) { throw "Password must be at least 6 characters." }
$again = Read-Plain "Type the password again"
if ($password -ne $again) { throw "The passwords don't match." }

# dollar-quoting with a random tag, so any character in the password is safe
$tag = "pw" + [guid]::NewGuid().ToString("N").Substring(0, 8)
$pwSql = "`$$tag`$$password`$$tag`$"

Write-Host "`nSaving admin email..."
Invoke-Sql "insert into public.app_config (key, value) values ('admin_email', '$email') on conflict (key) do update set value = excluded.value;" | Out-Null

$exists = Invoke-Sql "select count(*) as n from auth.users where lower(email) = '$email';"
if ($exists -match '"n":\s*1') {
  Write-Host "Account exists - setting the new password and making it admin..."
  Invoke-Sql @"
update auth.users
   set encrypted_password = extensions.crypt($pwSql, extensions.gen_salt('bf')),
       email_confirmed_at = coalesce(email_confirmed_at, now()),
       updated_at = now()
 where lower(email) = '$email';
update public.profiles p set is_admin = (p.id = (select id from auth.users where lower(email) = '$email'));
"@ | Out-Null
} else {
  $users = Invoke-Sql "select count(*) as n from public.profiles;"
  if ($users -match '"n":\s*([0-9]+)' -and [int]$Matches[1] -ge 2) {
    throw "The app already has 2 accounts. Use the email of one of them, or delete one first."
  }
  Write-Host "No account with that email - creating the admin account..."
  $name = (Read-Host "Display name (what the other person sees)").Trim()
  if (-not $name) { $name = $email.Split("@")[0] }
  $body = @{ email = $email; password = $password; data = @{ display_name = $name } } | ConvertTo-Json -Compress
  $r = Invoke-WebRequest -Method Post "$SUPABASE_URL/auth/v1/signup" -SkipHttpErrorCheck `
        -Headers @{ apikey = $PUBLISHABLE_KEY; "Content-Type" = "application/json" } -Body $body
  if ($r.StatusCode -ge 300) { throw "Sign-up failed: $($r.Content)" }
  Invoke-Sql "update public.profiles p set is_admin = (p.id = (select id from auth.users where lower(email) = '$email'));" | Out-Null
}

$check = Invoke-Sql "select count(*) as n from public.profiles p join auth.users u on u.id = p.id where p.is_admin and lower(u.email) = '$email';"
if ($check -match '"n":\s*1') {
  Write-Host "`nDone. Log in at https://elddad.github.io/task-for-two/ with $email and your new password." -ForegroundColor Green
  Write-Host "The admin panel is in Settings."
} else {
  throw "Something went wrong - the account is not marked as admin."
}
