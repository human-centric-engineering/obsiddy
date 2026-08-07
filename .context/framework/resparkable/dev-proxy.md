# Local dev over `https://resparkable.test`

Resparkable is served in development at **`https://resparkable.test`**, not
`http://localhost:3016`. This file is why, and what to do when it stops working.

Read it before changing `PORT`, before changing `BETTER_AUTH_URL`, and before
concluding that the hostname is broken.

---

## 1. Two halves that have to agree

Nothing here is clever. It is one number written in two places, and the whole
class of failure is the two disagreeing.

| Half                     | Where                                      | Says                                                                   |
| ------------------------ | ------------------------------------------ | ---------------------------------------------------------------------- |
| The proxy                | `dev-proxy/apps.json` → Laravel Herd nginx | `https://resparkable.test` → `127.0.0.1:3016`                          |
| The app                  | `.env.development` (committed)             | `PORT=3016`                                                            |
| The app's idea of itself | `.env.local` (ignored)                     | `BETTER_AUTH_URL` / `NEXT_PUBLIC_APP_URL` = `https://resparkable.test` |

If the first two disagree the proxy points at nothing and you get a **502**. If
the third is wrong the app serves fine and then redirects you to the wrong host
on login — which looks like an auth bug and is not one.

**Resparkable's port is 3016.** Sunrise's own is 3010; the registry exists so
that two Sunrise-derived apps running side by side don't both claim it.

## 2. The registry is a separate, shared repo

<https://github.com/human-centric-engineering/dev-proxy> — cloned at
`~/code/dev-proxy`. It maps every HCE dev app to a port, and it is **shared
across machines**: the way two developers stay aligned is by pushing that repo,
not by each configuring Herd by hand.

```bash
cd ~/code/dev-proxy
git pull            # someone else may have claimed a port
./apply.sh          # idempotent; re-asserts every mapping
./apply.sh --dry-run  # show what would change, touch nothing
```

`apply.sh` requires Laravel Herd, and refuses to run if Herd's TLD isn't `test`
(Herd _appends_ its TLD, so a mismatch would silently create
`resparkable.test.foo`). It also pre-flights for collisions with Herd sites
served directly — `herd links` / `herd parked`.

### The one thing `apply.sh` deliberately will not do

**It never deletes.** A proxy that isn't in `apps.json` is reported as drift and
left alone, on the grounds that silently removing someone's site would be rude.
So renaming a slug leaves the old hostname still being served:

```bash
herd unproxy obsiddy.test
```

This is exactly what the Obsiddy → Resparkable rename needed, and it is easy to
miss because `apply.sh` reports success while the stale proxy is still live.

## 3. Adding or changing an app

1. Edit `apps.json` — add an entry, or change a slug/port. Ports are blocked:
   `3000-3009` reserved (leave 3000 free), `3010-3019` one per app,
   `3020-3039` ConQuest domain instances.
2. `./apply.sh`
3. If you renamed or removed a slug, `herd unproxy <old>.test`.
4. Commit and push `dev-proxy`, or the other machine drifts.
5. In this repo, set `PORT` in `.env.development` to match, and
   `BETTER_AUTH_URL` / `NEXT_PUBLIC_APP_URL` in `.env.local` to the
   `https://<slug>.test` URL.

The hostname convention mirrors the **production site boundary**, not just the
name: apps that are siblings under one production domain get nested
(`hub.hce.test`) so cross-app requests are same-site in dev exactly as in prod.
Getting this wrong makes dev more permissive than production and hides
cross-site cookie bugs until deploy. The rule is written out in `apps.json`'s
`$namingRule`.

## 4. Google OAuth does not work here

`.test` is a reserved TLD, which is precisely why it is safe to use — and
precisely why Google will not issue an OAuth redirect to it. **Dev login is
email/password only.**

If you have been signing in to a dev site with Google, create an
email/password admin _before_ switching a host to `.test`, or you will lock
yourself out of your own dev environment.

## 5. When it breaks

| Symptom                                                | Cause                                                                                        |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| **502** from `https://resparkable.test`                | Nothing listening on 3016 — the dev server isn't running, or `PORT` drifted from `apps.json` |
| Cert error / `no alternative certificate subject name` | No proxy for that hostname. Run `./apply.sh`                                                 |
| Login bounces to the wrong host                        | `BETTER_AUTH_URL` / `NEXT_PUBLIC_APP_URL` in `.env.local` still on the old hostname          |
| Google sign-in fails                                   | Expected — see §4                                                                            |
| `Blocked cross-origin request to /_next/webpack-hmr`   | Set `ALLOWED_DEV_ORIGINS` — see [`services-env.md`](../../environment/services-env.md#port)  |

Verify the whole chain in one line:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://resparkable.test
curl -sS https://resparkable.test/api/health
```

A `200` plus a health payload with `"database": {"connected": true}` means DNS,
TLS, nginx, the port and the app all agree.

---

## Why this file is in the tier and not in `.context/environment/`

`services-env.md` is Sunrise-owned and documents the `PORT` **mechanism**
generically. This file documents **HCE's shared registry and Resparkable's
allocation in it** — fork facts that would be a merge conflict upstream. The
platform half is linked above rather than restated.
