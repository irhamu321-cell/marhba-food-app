# Marhba — food ordering marketplace

A working multi-vendor food ordering platform, in French and Arabic:
customers order, restaurants manage their menu and orders, an admin approves
restaurants and tracks commission. **Cash on delivery only, no courier app** —
the restaurant delivers itself, or the customer picks the order up.

Runs on **SQLite with nothing to install**, and on **PostgreSQL** by adding one
line to a file. Same code, same behaviour — the full test suite passes on both.

---

## 1. Run it

Install Node.js 22.5 or newer from [nodejs.org](https://nodejs.org), then
double-click **START-APP.bat** (Windows), or in a terminal:

```bash
cd food-app/server
node src/index.js
```

| What | Address |
|---|---|
| Customer app | http://localhost:3000 |
| Restaurant dashboard | http://localhost:3000/restaurant.html |
| Admin panel | http://localhost:3000/admin.html |

The first run creates the database and fills it with two demo restaurants,
menus, dish options and Arabic translations.

### Test accounts

Log in with **the phone number or the email** — both work.

| Role | Phone | Email | Password |
|---|---|---|---|
| Customer | 0633333333 | client@demo.ma | client1234 |
| Admin (super admin) | 0600000000 | admin@demo.ma | admin1234 |
| Restaurant — Snack Atlas | 0611111111 | resto1@demo.ma | resto1234 |
| Restaurant — Pizzeria Bella | 0622222222 | resto2@demo.ma | resto1234 |

Each of the ten demo restaurants has its own owner account. Password for all of
them: `resto1234`.

| Restaurant | Cuisine | Service | Owner phone |
|---|---|---|---|
| Bella Napoli | Italienne | Immediate | 0611000001 |
| Roma Gourmet | Italienne | Pre-order 24h | 0611000002 |
| La Trattoria Kénitra | Italienne | Immediate | 0611000003 |
| Milano Cucina | Italienne | Pre-order 48h | 0611000004 |
| Dar Zaki | Marocaine | Immediate | 0611000005 |
| Le Grill Royal | Grillades | Immediate | 0611000006 |
| Burger House | Fast food | Immediate | 0611000007 |
| Sushi Kénitra | Asiatique | Pre-order 24h | 0611000008 |
| Fit & Fresh | Healthy | Immediate | 0611000009 |
| Douceurs & Co | Desserts | Pre-order 24h | 0611000010 |

Create your own team accounts from **Admin → Equipe**; the demo admin is a
super admin and can hand out the operations, finance and support roles.

**Change the admin password before putting this online** (Account → change password).

### Commands

```bash
node src/index.js                  # start the app
node src/seed.js --reset           # wipe and recreate demo data
node src/migrate-to-postgres.js    # copy SQLite data into PostgreSQL

# from the project folder, with the app running:
node test/smoke.js                 # API tests
node test/ui/run-all.js            # browser tests (needs Playwright)

# these need no running server:
node test/service.mjs              # pre-order rules
node test/codes.mjs                # one-time codes: expiry, reuse, brute force
node test/backup.mjs               # backup and restore, every table
node test/startup.mjs              # what production refuses to start on
```

### Testing on your Android phone (same wifi)

The app stays on your home network — nothing is published to the internet.

**1. Start the app on the PC.** Double-click `START-APP.bat`. In the black
window, under the localhost lines, it prints something like:

```
  Sur ton telephone (meme wifi) :
      http://192.168.1.14:3000
```

That address is your PC's local IP, found automatically. If you ever want to
check it by hand, open Command Prompt and run `ipconfig` — it's the
**IPv4 Address** of the adapter you're actually using (Wi-Fi, not Ethernet, if
you're on wifi).

**2. Allow Node through the firewall.** The first time, Windows shows a box
titled *"Windows Defender Firewall has blocked some features of this app"*.
Tick **Private networks** and click **Allow access**. If you clicked Cancel, or
no box appeared and the phone can't connect, open Command Prompt **as
administrator** (right-click → Run as administrator) and paste:

```
netsh advfirewall firewall add rule name="Marhba app" dir=in action=allow protocol=TCP localport=3000 profile=private
```

To remove it later: `netsh advfirewall firewall delete rule name="Marhba app"`.

**3. Open it on the phone.** Connect the phone to the **same wifi** as the PC,
open Chrome, and type the address exactly, including `http://` and `:3000`:

```
http://192.168.1.14:3000
```

Use your own number from step 1. Add it to your home screen (Chrome menu →
*Add to Home screen*) and it opens like an app.

**4. What to test from the phone**

*As a customer* — `http://YOUR-IP:3000`
Sign up with a phone number, browse a restaurant, add a dish and pick its
options, apply a promo code in the cart, order as pickup and as delivery,
watch the status bar move, cancel an order while it is still pending, switch to
Arabic, open Help and send a message, read the legal pages, edit your details
in Account.

*As a restaurant* — `http://YOUR-IP:3000/restaurant.html`
Log in as `0611111111` / `resto1234`. Keep this open on a second device or
tab while you order from the first: the order appears within 15 seconds and the
phone rings. Run it through Accept → Preparing → Ready → Collected. A delivery order shows the customer's
name and phone, the full written address with building, floor and landmark, and
a **map link** for the pin. Add a dish
with an option group, change a price, close the restaurant and check it shows
as closed to customers.

*As the admin* — `http://YOUR-IP:3000/admin.html`
Log in as `0600000000` / `admin1234`. Approve a pending restaurant, change a
commission rate, refund part of a completed order, create a promo code, suspend
and reactivate a test customer, read the message you sent from the customer
side, and check the audit log recorded all of it.

**If the phone can't connect**

- The phone is on mobile data, not wifi — turn wifi on.
- A VPN is running on the PC or the phone (NordVPN and friends reroute traffic
  and hide the local network). Disconnect it while testing.
- Guest wifi, or "client isolation" on the router — devices can't see each
  other. Use the main network.
- The black window was closed, or the PC went to sleep.
- You typed `https://` — it must be `http://`.

---

## 2. Before you go live

Three things must be filled in. The app refuses to start in production until
they are, which is deliberate.

### Your business details

The terms, the privacy policy, the legal notice and the contact page are built
from nine values. They start **empty on purpose**: nobody should invent a
company name or a registration number for you, and a wrong RC or ICE number in
a published policy is a false record.

Fill them in **one** of two places:

- `server/config/business.js` — edit the `DEFAULTS` block, or
- your `.env` file — set the matching variable (the environment always wins)

| Variable | What it is | Needs an official document |
|---|---|---|
| `BUSINESS_NAME` | The name you trade under | — |
| `LEGAL_FORM` | SARL, SARL AU, auto-entrepreneur, personne physique… | — |
| `RC_NUMBER` | Registre de commerce number | **Yes** — your modèle J or certificat d'immatriculation |
| `ICE_NUMBER` | Identifiant commun de l'entreprise, 15 digits | **Yes** — issued by the DGI |
| `BUSINESS_ADDRESS` | Registered address | — |
| `BUSINESS_CITY` | City of the registered office | — |
| `BUSINESS_PHONE` | A number a customer or an authority can call | — |
| `BUSINESS_EMAIL` | An address you actually read | — |
| `RESPONSIBLE_PERSON` | The named person responsible for personal data | — |
| `CNDP_DECLARATION` | Declaration number — **leave empty until filed** | **Yes** — from the CNDP |

While any required field is empty:

- the legal pages show `[À COMPLÉTER : …]` where the value belongs, so nobody
  mistakes an unfinished policy for a finished one;
- the admin panel shows a warning banner on every screen;
- `NODE_ENV=production` **refuses to start**.

**The legal text is a template, not legal advice.** It is written for a
cash-on-delivery marketplace in Morocco and refers to law 09-08 and the CNDP.
Have a Moroccan lawyer read it, and **confirm with the CNDP whether a
declaration is required for your processing** before opening to the public. The
privacy policy says plainly that the declaration is in progress and claims no
approval; do not change that sentence until you have a real number. The admin
panel carries a 15-point CNDP checklist to work through.

### A real administrator password

`SEED_DEMO_DATA` is **off** by default, so a fresh database has no demo
accounts at all. The first start creates one administrator:

- with `ADMIN_PASSWORD` set, it uses that password;
- without it, it generates a random one, prints it once, and writes it to
  `data/FIRST-ADMIN-LOGIN.txt`. Change it and delete that file.

In production, `ADMIN_PASSWORD` is required and a missing or weak `JWT_SECRET`
refuses the start.

### Verification codes

Phone verification is on. There is **no SMS provider wired in**, so a code is
printed in the server window and listed in **Paramètres → Système**, where you
read it out during a pilot. That is enough for a handful of restaurants and
obviously not enough for the public.

To plug in a provider, call `setDelivery()` once at start-up with a function
that sends the code; nothing else changes. The pilot console turns itself off
in production (`OTP_CONSOLE=false` is the production default).

---

## 3. Switching to PostgreSQL

The app speaks PostgreSQL natively — no package to install, the driver is part
of the code. What you do need is a PostgreSQL **server** running somewhere.

1. Install PostgreSQL on the machine that will run the app
   ([postgresql.org/download](https://www.postgresql.org/download/)) and create
   a database, for example `marhba`.
2. Copy `.env.example` to `.env` and put your address in it:

   ```
   DATABASE_URL=postgres://postgres:yourpassword@localhost:5432/marhba
   ```
3. Already have orders in SQLite? Move them across first:

   ```bash
   cd server
   node src/migrate-to-postgres.js
   ```
   It copies every table and leaves the SQLite file untouched, so you can go back.
4. Start the app. The first line it prints tells you which database it is on.

Until you create that `.env`, the app runs on SQLite — which is a real
transactional database and perfectly adequate for a pilot. Postgres earns its
keep when several machines need the same data, or when you want a managed,
replicated database at a host.

---

## 4. Two kinds of restaurant

Every restaurant is one of two kinds. The restaurant chooses, and you can
change it for them from the admin panel.

**Commande immédiate** — the customer orders now and the food arrives within
hours. The card shows "Prête dans 30 min".

**Précommande** — the customer picks a delivery **day** and a **time slot**, at
least so many hours ahead. The restaurant sets four things:

| Setting | What it means |
|---|---|
| Minimum preparation time | 24h, 48h, 72h, or any number of hours you type |
| Delivery days | Which weekdays it delivers. Nothing ticked = every day |
| Delivery time slots | `11:00-13:00`, `18:00-20:00`, one per line |
| Ordering cutoff | Past this hour, the first possible day moves one day later |

The customer cannot send a pre-order without choosing a day and a slot, and the
**server checks it again** — a request with a day the restaurant does not work,
or a slot it does not offer, is refused with a clear message. The order then
carries its delivery day and slot everywhere: in the customer's order list, in
the restaurant's board, and in the admin orders table.

Restaurants also carry **cuisine tags** — Italienne, Marocaine, Fast food,
Grillades, Asiatique, Healthy, Desserts — which drive the filters on the
customer home page.

### Try it in two minutes

**An immediate order**

1. Open `http://localhost:3000`
2. Tap **⚡ Commande immédiate**, then **Bella Napoli**
3. Add a Pizza Margherita, pick a size, add it to the cart
4. Open the cart, choose delivery, type an address, **Commander**
5. The order appears with a progress tracker

**A pre-order**

1. On the home page tap **📅 Précommande**, then **Roma Gourmet**
2. A purple note explains the restaurant cooks to order
3. Pick a **day** from the strip, then a **time slot** — a green line confirms it
4. Add two dishes (the minimum here is 120 MAD), open the cart
5. The cart repeats your delivery day; **Commander** is disabled until you pick one
6. After ordering, the order reads *"Précommande — livraison prévue le …"*

**Change a restaurant's kind, as the restaurant**

1. Open `http://localhost:3000/restaurant.html`
2. Log in with `0611000001` / `resto1234` (Bella Napoli)
3. **⚙️ Réglages** → scroll to **Type de service** → tap **📅 Précommande**
4. Choose 48h, tick Tuesday and Friday, type two slots, save
5. Reload the customer home page: Bella Napoli is now under **Précommande**

**Change it as the admin**

1. Open `http://localhost:3000/admin.html`, log in with `0600000000` / `admin1234`
2. **Restaurants** → filter by cuisine or service, or search a name
3. Open one → the **Type de service · Cuisine** card: switch the kind, set the
   prep time, days, slots and cutoff, tick cuisines, set the displayed rating
4. **Commandes** has a **Type de service** filter: immediate or pre-order

## 5. What the app does

**Customer** — the first thing a new visitor sees is **"Where are you?"**, before
any restaurant: use my current location, choose a point on a map, or type the
address. Location is asked for only when that button is tapped, once, and never
tracked continuously. Picking a point opens a map with a **draggable pin** that
can also be moved by tapping, because a GPS fix in a Moroccan neighbourhood is
often a street or two out; the pin has to be confirmed, and then the written
details a courier actually needs are asked for — recipient, phone, city,
street, building, floor, landmark. Someone who only ever collects in person can
walk past the whole screen. Addresses are saved as **Home / Work / Other**, as
many as wanted, with one marked default; the chosen one sits across the top of
the home screen and can be changed at any time.

> **The map needs the internet.** It is drawn with Leaflet over OpenStreetMap
> tiles, both fetched from the web the first time a customer opens the picker —
> nothing is downloaded until then, and nothing is installed on your machine. If
> that fetch fails, on a weak connection or a blocked network, the same dialog
> opens **without the map**: the two coordinate fields are shown instead, so a
> customer who used the location button can still confirm what their phone
> reported, and everyone else can still reach the written address form. No one
> is ever stuck because a map would not load. The written address is required
> either way, because a pin alone will not find a door.

Then sign up with a **phone number** (email optional), and a home page
with a search box and two rows of filters: **service type** (all / immediate /
pre-order) and **cuisine**. Restaurant cards show the logo, name, cuisine,
service badge, rating, delivery fee, minimum order and either "Prête dans 30
min" or the pre-order delay. Open a menu, pick dish options (size, sauces,
extras) in a dialog that updates the price as you choose; on a pre-order
restaurant, pick a delivery **day** and **time slot** first. Cart, **promo
code**, checkout as pickup or delivery, cash on delivery, then a step-by-step
tracker that refreshes itself while the restaurant works. A delivery needs one of
your saved addresses **with a map pin** — pickup needs none — and the order keeps
a frozen copy of that address, so editing or deleting it later never rewrites
where a past order went. An account page to edit name, phone, email and
password, plus the address book; a help page with FAQ and a message form; and the legal pages.

**Restaurant** — log in with the **phone number** (email still works). An orders
board that receives new orders **pushed the instant they are placed** (a live
stream, with the 15-second refresh kept as a fallback for a proxy that buffers
or a phone that drops its connection) and **keeps ringing until the order is
accepted or refused** — one chime in a kitchen is one chime nobody heard. The
browser refuses to make any sound until it is clicked, and refuses silently, so
the board asks once, plainly, and plays a test chime when you agree. Each order
shows the chosen options and notes for the kitchen. Accept → Preparing → Ready → Collected. Menu editor for categories,
dishes, prices, and option groups, every field in French and Arabic. Settings
for delivery fee, minimum order, prep time, open/closed — and a **Type de
service** card to switch between immediate and pre-order and set the prep time,
delivery days, slots and cutoff. A figures page showing cash taken and
commission owed, plus the cash box.

**Admin** — a sidebar portal with fifteen sections, grouped (an order's detail
shows the same delivery address the restaurant sees, with its map link):

The panel has a **fixed dark sidebar** on a computer and a **drawer** on a phone
(the ☰ button), a top bar with global search, language switch, notifications and
an account menu, and the same fifteen sections everywhere.

*Pilotage* — **Dashboard**: today's orders with a comparison against yesterday,
revenue, commission, refunds, cash to reconcile; a **7-day chart**; today's
orders **broken down by status**; total, active and pending restaurants; the
**latest orders** with their service type; what needs you; and quick-action
buttons to every other section.

*Operations* — **Restaurants**: search by name or city and filter by status,
**service type** and **cuisine**; approve, reject (with a reason), suspend,
reactivate, edit every field, set the service type, prep time, delivery days,
slots, cutoff, cuisine tags and displayed rating, open or close temporarily,
change the commission,
and see the whole menu, recent orders, refunds and running balance on one page.
**Orders**: search by number, customer name or phone, filter by status, mode,
**service type** (immediate or pre-order), restaurant and date range; open any order to see items with their options,
totals, commission, status history, refunds and internal notes; cancel it,
refund it, or leave a note. **Catalog**: pick any restaurant and edit its
categories, dishes, prices, option groups and availability, with a best-sellers
table. **Customers**: search, then a profile with spend, order history,
refunds, messages, suspend/reactivate and password reset.

*Finance* — **Cash (COD)**: every restaurant-day showing what they collected,
what they owe you, what they declared and what you received, with the gap
computed; record cash, reconcile, or raise a dispute with a note.
**Settlements**: build a period report per restaurant (orders, gross,
commission, refunds, adjustments, net payable), approve it and mark it paid.
**Refunds**, **Commissions**, and **Reports** with CSV export on every table.

*Platform* — **Promo codes**, **Messages**, **Staff**, **Audit log** and
**Settings**.

**Staff roles.** Four roles decide what each person sees, enforced on the
server, not just hidden in the interface:

| | super_admin | operations | finance | support |
|---|---|---|---|---|
| Dashboard, orders, customers, reports | ✓ | ✓ | ✓ | ✓ |
| Approve/edit restaurants, catalog, promo codes | ✓ | ✓ | | |
| Refunds, cash, settlements, commission rates | ✓ | | ✓ | |
| Cancel orders | ✓ | ✓ | | |
| Audit log | ✓ | | ✓ | |
| Staff and settings | ✓ | | | |

Changing someone's role or deactivating them ends their session immediately.
You cannot deactivate yourself or change your own role, only a super admin can
create or modify another super admin, and the last active super admin cannot be
demoted.

**Settings** cover the platform name, support phone and email, displayed
currency, default language, the default commission applied to new restaurants,
a **maintenance mode** that stops customers ordering while you and the
restaurants keep working, and a switch that disables all promo codes without
deleting them.

**Audit log** records every sensitive action with who did it, when, from which
address and browser, and the before/after values. Filter by person, action,
resource type and date range.

**Both languages** — a button in the header switches the whole interface
between French and Arabic, including right-to-left layout. The choice is
remembered and saved to the account. Restaurants type their dish names in both
languages; customers see the one that matches their choice.

---

## 6. Cash reconciliation, in plain terms

The restaurant takes the customer's cash. It keeps the food money minus our
commission, plus any delivery fee. So at the end of each day it owes us the
commission, and nothing else.

The **Cash (COD)** screen turns that into one row per restaurant per day:

| Column | Meaning |
|---|---|
| Encaisse resto | cash the restaurant took from customers, minus refunds |
| Nous doit | our commission on that day — what they owe us |
| Declare | what the restaurant says it will hand over |
| Recu | what we actually received |
| Ecart | received − owed. Negative means short. |

A day moves **open → declared → received → reconciled**, and can be pushed to
**disputed** at any point with a note; resolving a dispute reconciles it. The
restaurant declares from its own dashboard (Chiffres → Ma caisse), so you are
never typing on their behalf.

A **settlement** groups a period into one document — orders, gross sales,
commission, refunds, adjustments, net payable — which you approve and then mark
paid. Marking it paid is idempotent: the same action sent twice does not pay
twice.

---

## 7. How the money works

Everything is stored in **centimes** (whole numbers), never decimals — 10500
means 105.00 MAD. Prices are recomputed on the server from the database on
every order; whatever the browser sends about price is ignored.

```
dish price           = base price + the options chosen
food subtotal        = sum of (dish price × quantity)
delivery fee         = the restaurant's fee, only if the customer chose delivery
customer pays (cash) = subtotal + delivery fee
platform commission  = subtotal × commission rate
restaurant keeps     = subtotal − commission + delivery fee
```

The commission rate is **frozen onto each order** when it is placed, so
changing a restaurant's rate never rewrites past orders — which is what you
want when the books are checked.

A **refund** eats into the food first, then the delivery fee, and the
commission and the restaurant's share are recomputed from what is left. Every
refund is kept as its own row with a reason and who did it.

**Promo codes.** Each code says who absorbs the discount:

- *Platform-funded* — the restaurant is paid exactly as if there were no
  discount, and the money comes out of your commission. Your net revenue tile
  shows commission minus what you gave away.
- *Restaurant-funded* — the discount reduces the food total, so commission is
  charged on what remains and the restaurant carries the cost.

A code can be a percentage (with an optional cap), a fixed amount, or free
delivery; limited to one restaurant; limited by minimum order, total uses, uses
per customer, and an end date. Codes are checked again on the server when the
order is placed, so a code edited in the browser is worth nothing.

The admin panel's **Commissions** tab shows the running total each restaurant
owes you. That is your revenue.

---

## 8. Security

- The phone number is the login, stored in one normalised shape, so `+212 6 12 34 56 78` and `0612345678` are the same account and cannot be registered twice.
- Passwords hashed with scrypt and a per-user salt.
- Signed tokens (HS256), valid 7 days; the key is generated on first run into `data/secret.key`.
- **Session revocation**: changing a password, "log out everywhere", or an admin
  password reset instantly invalidates every token already issued to that user.
- Every endpoint checks ownership: a customer cannot read another customer's
  order, a restaurant cannot touch another restaurant's menu, orders or options.
- Prices, totals, commission and option rules are enforced server-side only.
- Login limited to 10 failed attempts per IP per 15 minutes.
- **No open CORS**: the API answers its own pages only, unless you set `CORS_ORIGIN`.
- All input validated and length-capped; all output HTML-escaped.
- **Audit log** of every admin and money action, with before/after values, IP
  and browser: approvals, edits, commission changes, refunds, cancellations,
  cash receipts, reconciliations, settlements, staff changes, settings changes.
- **Role-based permissions** checked on the server for every admin endpoint.
- **Idempotency keys** on refunds, cash receipts and settlements: a repeated
  request replays the first answer instead of moving money twice.
- Every order, refund, reconciliation and settlement change runs in a database
  transaction.
- **Automatic daily backup** to `data/backups/`, 14 kept, works on both databases.
- **Uploaded pictures** are checked by their first bytes, not by what the
  browser claims: a file renamed `.jpg` that is really HTML is refused, and so
  is a declared type that disagrees with the content. The stored name is a
  random UUID with an extension derived from those bytes, so the name a client
  chose — `../../etc/passwd`, `shell.php` — never becomes a path. 5 MB cap,
  JPEG/PNG/WebP only, and only restaurant owners and admins may upload.
- Deleting a dish that appears in past orders hides it instead, so old receipts stay correct.
- **Location and addresses**: the browser is asked for a position only when the
  customer taps the button, once per tap, with `getCurrentPosition` — never
  `watchPosition`, so nothing is tracked in the background. Coordinates are
  range-checked (-90..90, -180..180), rejected if not finite, and rounded to six
  decimals. The server logs an address change by **neighbourhood, not by door**:
  the pin is cut to two decimals before it reaches a log line, and the written
  address never goes into one. A customer can only ever read, edit or delete
  their own addresses; asking for someone else's gets the same "not found" as
  an address that does not exist, so a stranger's address book cannot even be
  counted.

Before going live: HTTPS (Caddy or Nginx does it free), a real `JWT_SECRET` in
`.env`, the admin password changed, and backups copied somewhere off the machine.

---

## 9. What's inside

```
food-app/
├─ START-APP.bat        double-click to run (Windows)
├─ .env.example         copy to .env to change database, port or secret
├─ server/src/
│  ├─ index.js          HTTP server, routing, static files
│  ├─ store.js          one database interface, SQLite + PostgreSQL
│  ├─ pg-client.js      PostgreSQL driver written from scratch (no packages)
│  ├─ schema.js         tables and demo data        ← the data model
│  ├─ routes.js         every API endpoint          ← the business rules
│  ├─ auth.js           passwords and tokens
│  ├─ migrations.js     upgrades an older database without losing data
│  ├─ permissions.js    which staff role may do what   ← the permission table
│  ├─ settings.js       platform settings
│  ├─ cod.js            daily cash figures
│  ├─ reports.js        reports and CSV export
│  ├─ backup.js         daily backups
│  ├─ env.js            reads .env
│  ├─ seed.js           reset to demo data
│  └─ migrate-to-postgres.js
├─ web/
│  ├─ index.html + js/customer.js       customer app
│  ├─ restaurant.html + js/restaurant.js restaurant dashboard
│  ├─ admin.html + js/admin.js          admin shell and navigation
│  ├─ js/admin-*.js                     one file per admin section
│  ├─ js/i18n.js                        all French and Arabic wording
│  ├─ js/content.js                     FAQ + legal texts  ← fill in your details here
│  └─ app.css                           all styling, including right-to-left
├─ test/smoke.js        103 automated tests
└─ data/                the database and its backups — back this folder up
```

To change wording, open `web/js/i18n.js`: French on top, Arabic below.

---

## 10. Order lifecycle

```
pending ──> accepted ──> preparing ──> ready ──> completed
   │            │             │           │
   ├─> rejected │             │           │
   └─> cancelled└─> cancelled └─> cancelled└─> cancelled
```

The server refuses any jump that isn't on this diagram, so an order can never
be "completed" without having been accepted. A customer can only cancel while
the order is still `pending`. Every change is written to a history table with
who did it and when.

---

## 11. Putting it online

Three ready-made configuration files sit in `deploy/` and at the root:

| File | What it is for |
|---|---|
| `deploy/Caddyfile` | HTTPS, compression, security headers, and the one setting that matters — the order stream must not be buffered |
| `deploy/nginx.conf` | the same for nginx, with per-address rate limits on login and verification codes |
| `ecosystem.config.cjs` | PM2, if you prefer it to the systemd unit in DEPLOY.md. One process on purpose: SQLite is a file, and the live streams, stream tickets and rate limiter all live in this process's memory |

Both proxy templates carry a note about the one thing in them worth a
decision: the address map loads Leaflet from a CDN, so the policy trusts that
CDN. The note explains how to host it yourself and remove that trust.

**The full step-by-step guide is in [DEPLOY.md](DEPLOY.md)** — a small VPS,
Caddy in front for automatic HTTPS, systemd to keep it running, off-machine
backups, and an uptime check. It assumes no prior experience.

The short version:

```bash
NODE_ENV=production \
JWT_SECRET="$(openssl rand -hex 32)" \
ADMIN_PASSWORD="a-long-password" \
CORS_ORIGIN="https://your-domain" \
TRUST_PROXY=1 \
node src/index.js
```

The app listens on 127.0.0.1 behind the proxy, and refuses to start if any of
those is missing, weak, or set to something unsafe.

---

## 12. Backups and restore

A backup runs on start-up and then once a day. It writes **two** files per day
into `data/backups/`:

| File | What it is |
|---|---|
| `backup-YYYY-MM-DD.db` | A complete SQLite snapshot taken with `VACUUM INTO`, consistent even while the app is running. **This is what a restore uses.** |
| `backup-YYYY-MM-DD.json` | A readable row dump of every table, plus the schema. Useful for inspection, or to rebuild onto PostgreSQL |
| `backup-YYYY-MM-DD.manifest.json` | The table list, a row count per table, and the schema version |

The table list is **discovered from the database itself**, so a table added
tomorrow is backed up tomorrow. Fourteen days are kept.

**Restoring never touches the live database.** It writes a new file and checks
it before accepting it:

```bash
cd server
node src/restore.js ../data/backups/backup-2026-11-02.db ../data/restored.db
```

It prints a row count per table and **refuses** a backup that is missing,
empty, corrupted, truncated, incomplete, or written by a different format
version. If the restored file does not hold exactly the rows the manifest
recorded, it says which table is short and stops.

To actually swap a restored file in: stop the app, move the current
`data/app.db` aside, put the restored file in its place, start the app.

Trigger a backup by hand from **Paramètres → Système**, which also shows the
last result, the table and row counts, free disk space, and the recent
security and money events.

---

### Off-site copies

**A backup on the same disk as the database is not a backup.** The disk that
loses one loses the other. Fill these five in and every daily backup is
encrypted on this machine and pushed to an S3-compatible bucket — Cloudflare
R2, Backblaze B2, AWS S3, or anything that speaks the same API:

| Variable | What it is |
|---|---|
| `BACKUP_S3_ENDPOINT` | e.g. `https://<account>.r2.cloudflarestorage.com` |
| `BACKUP_S3_BUCKET` | The bucket name |
| `BACKUP_S3_KEY` / `BACKUP_S3_SECRET` | The access key pair |
| `BACKUP_ENCRYPTION_KEY` | A long passphrase of your choosing |
| `BACKUP_S3_PREFIX` | Optional folder inside the bucket, `marhba` by default |

Fill in **all five or none**. A half-filled configuration is refused at
start-up in production, because the dangerous version of this feature is the
one where two variables are set, nothing is reported, and you believe copies
are leaving the machine.

> **Keep `BACKUP_ENCRYPTION_KEY` somewhere other than this server.** The
> archives are encrypted with it before they leave, which is the point: the
> bucket holds every customer's name, phone number and address, and the
> storage provider has no business reading them. The same fact means a lost
> key is a lost backup. Nobody can recover it for you.

**The pictures go too.** Logos and dish photos are files under `web/uploads/`,
not rows in the database — the database holds the *path*, not the image. A
database-only restore brings back every order and every price and leaves the
menu with broken images, and reports no problem at all, because as far as the
database is concerned nothing is missing. So the photos are pushed as well,
each one **once**: a logo does not change overnight, and re-sending every
photo every night would cost real money on a metered bucket for nothing. A
small ledger in `data/offsite-uploads.json` remembers what has gone; delete it
and the next run simply sends everything again.

`data/backups/` itself still holds the database only. A second copy of the
photos on the same disk they already live on would protect against nothing.

**Paramètres → Système** shows whether copies are actually leaving: the last
success, the last failure, how many files have gone, and **how many photos are
still waiting**. That last number is listed separately on purpose — the
database copies and the photos can fail independently, and a growing pile of
unsent photos is easy to miss behind a green database backup. Every outcome is
also written to the audit log, so a backup that quietly stopped leaving three
months ago is visible after the fact.

If you would rather not back up images at all, paste links hosted elsewhere
into the picture fields instead of uploading — both editors accept a URL — and
there is nothing local to copy.

---

### Being told about an order when the screen is closed

A ringing browser tab only helps someone who has the tab open. Two optional
alerts cover the rest, both off by default:

| Setting | What it does |
|---|---|
| `ORDER_WEBHOOK_URL` | POSTs a flat JSON object on every order — point it at a WhatsApp Business relay, an n8n or Make flow, or your own script |
| `ORDER_WEBHOOK_SECRET` | Sent as `X-Marhba-Secret`, so the receiver can tell a real event from someone who guessed the URL |
| `ORDER_ALERT_SMS=true` | Texts the owner's phone through the SMS gateway. Costs one SMS per order — watch the bill |

The webhook says **that** an order has an allergy note, never what it says:
an allergy is health information about a customer, and it does not belong in
a third party's logs. The kitchen reads it on the ticket.

Neither alert can delay or fail an order. They fire after the order is safely
written, and a relay that is down is logged and dropped.

---

## 13. Before you open to the public

**Fill in your business details.** Open `web/js/content.js` and replace every
`[BRACKETED]` blank at the top — business name, legal form, RC/ICE, address,
phone, email. They appear throughout the Terms, Privacy policy and About pages.

**Have the legal texts checked.** They are a serious starting draft written
against Morocco's law 09-08 on personal data, and they describe what this app
actually does with customer data — but they are not legal advice. A lawyer
should read them before real customers do. The privacy policy also has a blank
for your CNDP declaration reference.

## 14. Still deliberately left out

Courier app, GPS courier tracking and dispatch (that was the Phase 1
decision); double-entry ledger and settlement runs; reviews; online card
payment; push notifications; support tickets.

**Delivery zones are not drawn yet.** Every active restaurant is shown to every
address, and a restaurant whose city differs from the selected address carries
the warning *"Ce restaurant ne livre peut-être pas à ton adresse."* Nothing is
hidden on that basis — the pilot needs you to find out by taking the calls who
actually delivers where, before a map of zones is worth drawing.

Phone verification and self-service password reset **do exist**, and so does
the SMS gateway: set `SMS_PROVIDER` to `infobip`, `twilio` or `generic_http`
with the matching credentials in `.env`, and codes go to the customer's phone
in French and Arabic. Left on `console` they are printed in the server window
and shown in the admin panel, which is how a pilot runs before you have an SMS
account — and production refuses to start on that setting, so it cannot be
shipped by accident. The provider wiring is covered by `test/sms.mjs` against a
fake transport; the one thing those tests cannot prove is that your account and
sender ID are accepted, so send yourself one code after deploying.

The two worth doing first, once real orders are flowing:

1. **Pointing `ORDER_WEBHOOK_URL` at a WhatsApp relay** — the hook fires on
   every order already; what is missing is the relay on the other end.
2. **Opening an SMS account** with a Moroccan aggregator and filling in
   `SMS_PROVIDER`, so the admin stops reading codes out during signup.

---

## 15. Going mobile later

The browser app already works on a phone. For real apps in the stores, the API
here is the contract: a Flutter or React Native app calls the same endpoints
(`/api/restaurants`, `/api/orders`, …) with the same token, and sets
`CORS_ORIGIN` in `.env`. Nothing in the backend has to change.
