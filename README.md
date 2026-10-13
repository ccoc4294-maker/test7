# Primo Barbershop — website with a real booking system

A static website (plain HTML/CSS/JavaScript — no build step) that uses **Supabase** as its database.
Bookings made by customers on **any phone or computer** are saved in the database and show up on the
owner's dashboard on **any device**.

> GitHub (and GitHub Pages) can only host the files. It cannot store bookings. That is why the
> database is Supabase. The free tier is enough for a single barbershop.

## What's in this folder

| File | What it is |
|---|---|
| `index.html` | The page: public site + owner login + owner dashboard shell |
| `styles.css` | All styling |
| `config.js` | **You edit this:** Supabase keys, promos, reviews, FAQ |
| `app.js` | Customer side: services, barbers, live availability, booking, walk-in queue |
| `admin.js` | Owner dashboard: bookings, queue, reports + commission, inventory, staff |
| `schema.sql` | **You run this once** in Supabase: tables, security rules, booking functions, starter data |
| `assets/` | Logo, shop photo, gallery photos (upload these as files) |

## Setup (about 15 minutes)

### 1. Create the database
1. Sign up at <https://supabase.com> and create a **New project** (pick the region closest to the Philippines, e.g. Singapore). Save the database password somewhere safe.
2. Open **SQL Editor → New query**, paste the whole of `schema.sql`, press **Run**. It should finish with "Success".

### 2. Create the owner account
1. **Authentication → Users → Add user → Create new user.** Enter the owner's email and a strong password, and tick **Auto Confirm User**.
2. Back in **SQL Editor**, run this (use the same email):
   ```sql
   insert into public.owners (user_id)
   select id from auth.users where email = 'OWNER_EMAIL_HERE';
   ```
   Only accounts listed in the `owners` table can see bookings. Anyone else gets nothing.
3. **Authentication → Sign In / Providers** (or *Settings*): turn **off "Allow new users to sign up"** so nobody can create accounts.

### 3. Connect the website
1. **Project Settings → API.** Copy the **Project URL** and the **anon public** key.
2. Paste them into `config.js` (`SUPABASE_URL`, `SUPABASE_ANON_KEY`).
   The anon key is *meant* to be public (the security rules in `schema.sql` protect the data).
   **Never** put the `service_role` key in the website.

### 4. Put it on GitHub Pages
1. Create a GitHub repository and upload everything in this folder (keep the `assets` folder; images must be uploaded as files, not pasted).
2. **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)` → Save.**
3. After a minute the site is live at `https://YOUR-USERNAME.github.io/REPO-NAME/`.
4. In Supabase **Authentication → URL Configuration**, set **Site URL** to that address.

### 5. Test it
1. Open the site on a phone, book an appointment.
2. On another device, open the site, tap **Owner login** (footer), sign in with the owner email and password. The booking is there.

## How it works

- **Customers** never touch the bookings table. They call database functions (`create_booking`, `get_busy`, `cancel_booking`, …) that validate everything on the server: business hours, barber schedule, the real service price, and double-booking (the database itself refuses overlapping bookings for a barber).
- A customer gets a **booking code** after booking. Code + phone number lets them view or cancel (up to 2 hours before).
- **Owner** signs in with Supabase Auth; the session survives page refreshes. The dashboard refreshes by itself every 30 seconds.
- Booking times use **Asia/Manila** time everywhere.
- **Auto no-show:** confirmed bookings still open 24 hours after their time become "no-show" (runs whenever the dashboard loads). Optional — run it on a schedule too (enable the `pg_cron` extension, then):
  ```sql
  select cron.schedule('auto-no-show', '*/15 * * * *', $$select public.auto_expire_bookings()$$);
  ```
- **Commission:** the barber's rate is locked in at the moment you press *Complete*, so changing a rate later does not rewrite past earnings.

## Everyday changes

| I want to… | Where |
|---|---|
| Add/remove staff, change their hours or commission | Owner dashboard → Staff |
| Change prices, services, or shop hours | Supabase → **Table Editor** → `services` / `shop_hours` |
| Edit promos, reviews, FAQ | `config.js` |
| Replace photos | Upload new files into `assets/` with the same names |
| Change address / phone / Facebook | `index.html` (About section) |

## Things to know

- **Free-tier limits:** Supabase may pause free projects after about a week with no activity, and then the site stops working until you resume it. Check Supabase's current free-plan terms; the paid plan removes this.
- **Spam:** the form has a hidden "honeypot" field, and the server allows at most 3 upcoming bookings per phone number. For stronger protection add a CAPTCHA such as Cloudflare Turnstile.
- **Privacy:** you are storing customers' names and phone numbers. Add a short privacy notice to the site and follow the Philippine Data Privacy Act. Only the owner account can read them.
- **Reminders by SMS/email are not included.** Texting needs a paid SMS provider and a Supabase Edge Function that sends the message (for example 24 hours before a booking). This is the natural next step.
- **Online payments are not included** (the shop takes cash/GCash in person).
- **Loyalty points** are the number of completed visits for a phone number. Redeeming a free cut is done by the barber; the site does not track redemptions.
- The sample **reviews, promo prices, barber names and commission rates** are placeholders. Replace them with real ones.
- Backups: Supabase free projects have limited backups. Export the `bookings` table from the Table Editor (CSV) now and then.

## Troubleshooting

- *Red "Setup needed" banner:* `config.js` still has the placeholder URL/key.
- *"Could not load the shop data":* `schema.sql` did not run completely, or the URL/key is wrong. Re-run `schema.sql` (it is safe to run again).
- *Owner login says "not authorized":* the user is not in the `owners` table (step 2.2).
- *No times shown:* check `shop_hours`, and that at least one barber is active with working hours that day.
