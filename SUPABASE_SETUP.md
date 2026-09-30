# Turning on the shared team library (Supabase) — step by step

With this set up, everyone on the crew who opens the app link and signs in sees the **same photos, rigs, customers
and pipe specs**. Phones still keep their own copy, so the app keeps working with no signal. Changes upload when
signal comes back.

**Cost:** $0 on Supabase's Free plan. That's plenty to start (see "Limits" at the bottom).
**Time:** about 15 minutes.
**You need:** your GitHub account (you already have one for the app) and a computer with a web browser.

> **Two passwords, don't mix them up**
> 1. **Database password.** Supabase asks for it when the project is created. You'll almost never need it again.
>    Save it in your password manager. Don't give it to the crew.
> 2. **Team password.** This is the one the crew types into the app (step 5). Pick something you can say out loud.

Menu names below were checked against Supabase's docs and dashboard source code in September 2026. Supabase
changes its screens from time to time. If a button looks a little different, look for the closest match.

---

## 1. Create your free Supabase account
1. Go to **https://supabase.com** and click **Sign in** (or **Start your project**).
2. Click **Continue with GitHub** and approve access with your GitHub account.
3. If it asks you to create an **organization**, name it something like *Hardband* and pick the **Free** plan.

## 2. Create the project
1. On the dashboard, click **New project**.
2. Fill in:
   - **Organization:** the one you just made.
   - **Project name:** `hardband-photos`
   - **Database password:** click generate, or type a strong one. **Save it** in your password manager (see the box above).
   - **Region:** pick the one closest to where you work (for Texas/Oklahoma, any US region is fine,
     e.g. *East US (North Virginia)*).
   - **Security** section:
     - **Enable Data API:** leave it **checked**. The app needs this.
     - **Automatically expose new tables:** either setting works. The setup script grants access itself.
     - **Enable automatic RLS:** either setting works. The setup script turns on security itself.
3. Click **Create new project** and wait 1–2 minutes until the project finishes setting up.

## 3. Create the tables and the photo storage (copy and paste)
1. In the left sidebar, click **SQL Editor**.
2. Start a new, empty query (a **+** or **New query** button).
3. Open the file `supabase/setup.sql` from the app's GitHub repository (branch `shared-sync`), copy **all** of it,
   and paste it into the editor.
4. Click **Run**.
   - You may get a **"Potential issue detected"** box that says the query has destructive operations.
     That's expected. The script replaces its **own** access rules if you run it again, and it never deletes data.
     Click **Run query**. If you're offered **Run and enable RLS**, that's fine too.
5. Near the bottom you should see a small results table: customers 1, rigs 1, pipe_specs 1, photos 0.
   That means it worked. (Running it again later is safe.)

This created:
- tables **customers, rigs, pipe_specs, photos**, with EOG / rig "Six" / 4-1/2" Range 3, 450 Duo already in them,
- a **private** storage bucket called **hardband** for the photos and thumbnails,
- security rules so that **only signed-in crew** can see or change anything, and **nobody can hard-delete** anything.

### Already set up before the Before/After hardband stage? Run this once
If your project was created with an older `setup.sql`, add the new **stage** column (Before / After hardband):
1. **SQL Editor** → new query.
2. Paste all of `supabase/migrations/002_stage.sql` and click **Run**. It only adds a column; nothing is changed or deleted,
   and it's safe to run again.
3. The results show your photos by stage. Older photos show as `null (= post)`, which the app treats as *After hardband*.

Phones keep syncing even before you run it; photos marked *Before hardband* get their stage uploaded afterwards.

### Add the Operator column (who did the work) — run this once
1. **SQL Editor** → new query.
2. Paste all of `supabase/migrations/003_operator.sql` and click **Run**. It only adds a column; nothing is changed or deleted,
   and it's safe to run again.
3. The results show your photos by operator. Older photos show as `null (= No operator)`.

Phones keep syncing even before you run it: the operator stays on each phone and is uploaded automatically once the
column exists. Until then, other phones don't see who took a photo.

## 4. Create the team login
1. In the left sidebar, click **Authentication**, then **Users**.
2. Click **Add user**, then **Create new user**.
3. **Email address:** an address the crew will type, e.g. `crew@yourcompany.com`.
   (It doesn't have to receive mail, but use one you control.)
4. **User Password:** the **team password**.
5. Make sure **Auto Confirm User?** is **checked**. It's checked by default. This lets the login work right away,
   without an email link.
6. Click **Create user**.

## 5. Turn OFF public sign-ups (important)
The app's key is public by design, so if sign-ups stay on, a stranger could make their own account.
1. Still under **Authentication**, open **Sign In / Providers**.
2. Turn **Allow new users to sign up** **off**.
3. Click **Save changes**.

## 6. Copy the two values the app needs
1. Near the top of the project page, click the **Connect** button. It shows the **Project URL**
   (looks like `https://abcdefghijklmnop.supabase.co`) and the **Publishable key** (starts with `sb_publishable_`).
2. You can also find the key under **Project Settings → API Keys**.
   - Use the **Publishable** key. If you only see the older **anon** key (a long string starting with `eyJ`), that works too.
   - **Never** use the **secret** key (`sb_secret_...`) or the **service_role** key. Those unlock everything.

## 7. Put the values in the app and publish
Send the **Project URL** and the **Publishable key** to whoever maintains the app (your assistant can do this part).
Both are safe to share, since they're meant to be public. They get pasted into `config.js`:
```js
window.HB_CONFIG = {
  supabaseUrl: 'https://abcdefghijklmnop.supabase.co',
  supabaseKey: 'sb_publishable_xxxxxxxxxxxxxxxx',
};
```
Then the `shared-sync` branch gets merged into `main`, and GitHub Pages republishes the site in a minute or two.
Until then, the live site keeps working exactly as it does today.

## 8. On each phone (once)
1. Open the app from its Home Screen icon. Close it and open it once more so it loads the new version.
2. Tap **⤓** (Backup) at the top. Under **Team sign-in**, enter the team email and team password, plus your
   name if you like (it records who changed what). Tap **Sign in**.
3. The pill at the top shows **✓ Synced** once everything is uploaded. Photos already on the phone get uploaded
   automatically and **stay on the phone**.

What the pill at the top means:

| Pill | Meaning |
|---|---|
| **✓ Synced** | Everything is shared and up to date |
| **↑ 3 pending** / **Uploading…** | Changes waiting to upload, or uploading right now |
| **Offline · 3** | No signal. 3 changes will upload by themselves when signal returns |
| **⚠ Sync** | Can't reach the team server (see "Pausing" below). Your photos are safe on the phone |
| **Signed out** | This phone isn't sharing. Tap it to sign in |

---

## Good to know

**Pausing (Free plan).** Supabase pauses a free project after about a week with little or no use. It emails the
account owner before this happens. Normal daily crew use keeps it awake. If it does get paused:
- the app still works on every phone: photos are saved on the phone and marked pending,
- the owner signs in at supabase.com, opens the project, and clicks **Resume project**. After that, phones catch up
  by themselves,
- per Supabase's docs, a paused project can be resumed for a limited time (currently up to 1 year). Don't let it sit paused.
To get rid of pausing completely, upgrade to Pro ($25/month) under the organization's **Billing**.

**Someone leaves the crew?** Replace the team login. The dashboard doesn't have a simple "change password" box
(it only sends a password-recovery email, which this app doesn't use). Do this instead:
1. **Authentication → Users**, click the team user, then **Delete user**. This removes only the login.
   Photos and tags aren't tied to it and are **not** affected.
2. **Add user → Create new user** with the same email and a **new** password (Auto Confirm checked).
Every phone then shows **Signed out**. Sign in again with the new password on the phones that should keep access.
Their photos stay on the phone the whole time.

**Deleting.** Deleting a photo in the app hides it on every phone. A copy stays on the server, and nothing in the
database or storage can be hard-deleted by the app.

**Backups.** The Free plan has no automatic database backups. Keep using **Export ZIP** now and then.

**Limits (Free plan, checked Sept 2026 at https://supabase.com/pricing):** 500 MB database, 1 GB file storage,
5 GB egress (downloads) per month. Each photo takes roughly 0.1–0.55 MB (full size plus thumbnail), so 1 GB holds
about 2,000–10,000 photos, and about 3,500 at a typical 0.3 MB. When it fills up, Pro ($25/month) includes 100 GB.
