# Session vault

The assistant learns tasks on arbitrary sites and replays them from cached
runbooks, so it has to hold authenticated sessions for many sites at once. This
is where they live: encrypted, per domain, several accounts per domain so a
burned session does not take a demo down with it.

```
vault list                                  domains, labels, import times, expiry
vault show <domain> <label>                 cookie names, lengths, dates
vault add <file> --domain d --label l       import an exported session
vault rm <domain> <label>
vault select <domain> [--label l]           which session would be used, and is it usable
vault import <domain> [--label l]           install into the box's browser, then verify
vault probe <domain> [--auth-url u]         box vs host, the blocked/broken diagnostic
vault probe <domain> --discover             name candidate signed-in markers
vault marker <domain> --signed-in <sel>     record the positive marker
vault capabilities [<domain>]
vault signup <domain> --mailbox you@ours    opt-in, refuses by default
```

Run it as `node scripts/vault.mjs …` or `npm run vault -- …`.

## Three things that are not true, and cost us hours each

Assume all three hold on a new domain until its probe says otherwise.

**Being able to read a site does not mean you can log into it.** Bot vendors
guard auth endpoints far harder than content. Measured on Resy — identical
request, only the source IP differing:

| request                    | Sailbox              | residential |
| -------------------------- | -------------------- | ----------- |
| `OPTIONS /4/auth/mobile`   | 500, no CORS headers | 204         |
| `OPTIONS /3/auth/refresh`  | 500                  | 204         |
| `OPTIONS /4/find`          | 204                  | 204         |

Search returned 80 real results from the box the whole time. Only auth failed.
In a browser this is invisible: a 500 with no `Access-Control-Allow-Origin` is
indistinguishable from a CORS misconfiguration, so the console blames CORS and
the login button silently does nothing. Three people lost hours to "the account
must be unverified" before a source-IP comparison settled it.

**A session is not a cookie.** It is a cookie plus the right to refresh it.
Resy's cookie is a refresh token exchanged at `/3/auth/refresh` on every page
load, so importing it into an environment that cannot reach that endpoint yields
a valid credential that never activates. Any site minting short-lived access
tokens behaves this way, which is why the capability record tracks the refresh
endpoint separately from the auth endpoint.

**"No login button" is not proof of a session.** It is also what an unhydrated
page looks like. An early draft of the import script checked for the absence of
a login control after a fixed sleep and reported AUTHENTICATED for a profile
holding nothing but junk cookies. `src/vault/sessionCheck.js` waits for the page
to actually render, requires a *positive* signed-in marker, and returns
`unknown` rather than guessing. A domain with no positive marker recorded
**cannot be reported authenticated at all**.

A false positive is the worst outcome available in this component: a rejected
session is byte-identical to a working one until the demo.

## Probing a new domain

`probe` sends the same request from the box and from your machine and compares.
That comparison is the only diagnostic that distinguishes *blocked* from *broken
form*.

```
VAULT_SAILBOX=booking node scripts/vault.mjs probe resy.com
```

| box  | host | verdict            | means                                            |
| ---- | ---- | ------------------ | ------------------------------------------------ |
| ok   | ok   | `box-ok`           | authenticate straight from the box                |
| fail | ok   | `residential-only` | egress blocking — the box needs the tunnel        |
| fail | fail | `broken-request`   | the request or the endpoint. Not egress. Fix it.  |
| ok   | fail | `inconclusive`     | re-run before recording anything                  |

Both sides run the **same curl command**; only the machine differs. This matters
more than it looks. The host side originally used Node's `fetch` while the box
used curl, and against Resy's auth endpoint those two disagree on an identical
request — curl gets 204, `fetch` gets 500, because undici's default headers and
TLS fingerprint are neither a browser's nor curl's. A client difference that
large reads as an egress difference and the probe reports "blocked" for two
requests that were never the same. Both clients' versions are recorded in
`clients` so a remaining mismatch is visible rather than silent.

`probe` never carries a credential — it is an unauthenticated CORS preflight —
but it still refuses an `--auth-url` off the domain, so a typo cannot record
another site's behaviour under this one.

When the verdict is `residential-only`, the box authenticates through your
egress:

```
ssh -N -R 1080 booking.sail
chromium --proxy-server=socks5://127.0.0.1:1080
```

## Discovering the signed-in marker

Run this against a session you *know* is logged in — a marker picked off a
logged-out page is always present and therefore always "proves" authentication.

```
node scripts/vault.mjs probe resy.com --discover
node scripts/vault.mjs marker resy.com --signed-in '[data-test-id="…profile_photo"]'
```

## Expiry

The vault decodes the token's `exp` where it can find one — including a JWT
wrapped in URL encoding or carried inside a JSON cookie value, which is Resy's
shape. Failing that it falls back to the latest cookie expiry as an upper bound,
and otherwise records the lifetime as unknown.

Expiry is a **refusal input, never a health signal**. Past its `exp` a session
is certainly dead and `select` refuses it by name, telling you which account to
re-import. Before its `exp` it is merely not-certainly-dead — only positive
evidence from the site says otherwise. An expired session is refused at `select`
*and* again at install, so a caller holding a stale record cannot route around
it. Nothing expired ever reaches a run.

## Encryption at rest

The vault is AES-256-GCM. The key comes from one of two places and there is no
third:

1. `KP_VAULT_KEY` — base64 of 32 random bytes. Linux, the Sailbox, CI.
2. the macOS keychain, generated on first use.

There is deliberately no plaintext fallback: a vault that silently degrades when
the keychain is locked is worse than one that refuses, because nobody notices
until the file is already on disk. GCM's auth tag means a truncated or edited
vault fails loudly instead of decrypting to something plausible.

The vault lives at `~/.kp-hackathon/vault.enc.json` (override with
`KP_VAULT_PATH`), mode 0600, and **refuses to be written anywhere inside the
working tree**. `.gitignore` is not sufficient on its own — a rename, a new
worktree or a `git add -f` all defeat it, and that failure is permanent and
public. Nothing plaintext reaches the file: not the token, not the cookie names,
not the domain list.

Every line the CLI prints goes through a redactor holding the loaded session's
values, so a value cannot reach the terminal even by accident. Names, byte
lengths and dates only.

## Account creation

Off by default, and narrow on purpose. Automated signup is viable only where the
team controls the identity: a mailbox on a domain we own, for a site whose terms
permit additional accounts, and where no SMS step exists. It is an opt-in
per-domain adapter (`KP_VAULT_SIGNUP_DOMAINS`), never a default, and every
account records the real mailbox it belongs to.

There is no fabricated-identity path and no bulk generation, and their absence
is deliberate rather than an oversight. Most sites gate signup behind SMS — Resy
does, at the same `/4/auth/mobile` the box cannot reach — it is against typical
terms of service, and on booking sites the accounts hold real inventory, where a
no-show is a real cost to a real business. Account count per domain is capped at
3, enough to rotate.

Where signup is not viable, the supported path is a human logging in on their
own machine and importing the session. That is the normal path, not a fallback.

## Testing

`npm test` covers the vault with no network, no Sailbox and no real credential:
a synthetic browser for the auth check, injected transports for the probe
comparison, and synthetic JWTs for expiry. Real behaviour stays behind explicit
opt-in — `VAULT_SAILBOX` for probing, mirroring `BOOKING_SAILBOX` in
`scripts/booking_bridge.mjs`.

The one exception is `src/vault/__tests__/keychain.test.js`, which drives the
real `security` binary against a throwaway keychain under a test-only service
name. It earns the exception: the first implementation used the documented "bare
`-w` prompts for the password" form, which — with an explicit keychain path —
makes `security` consume the *path* as the password and write the item to the
login keychain instead. Exit code 0, plausible output, key silently in the wrong
store. Only a real invocation catches that.
