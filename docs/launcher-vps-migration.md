# Launcher 1.5.6: moving an existing account with its server

The ReforgedRevival 1.14.7 deployment moved from `187.127.54.193:4443` to
`179.199.154.171:4443`, retaining its TLS certificate and account database.
Launcher 1.5.6 updates that saved endpoint at startup and also accepts existing
invites for the old endpoint. The rule requires the exact original certificate
fingerprint and the `reforged` game; other servers and Dauntless 1.4.4 are unchanged.

For a public server at another address, joining its new invite automatically
copies the saved account only when the game, server name and pinned certificate
match and there is exactly one distinct saved account to copy. The original
encrypted key remains available for recovery. An account already saved at the
destination is never replaced. Private-server moves retain their existing
confirmation flow. Network connections still verify the pinned certificate
before sending account credentials.

Players update/reopen the launcher and enter their existing account; they do not
register a new account or retype a saved key. Everyone may use the same server
invite: the local key identifies each player's own account. A player with no saved
key still needs their recovery backup. If a separate account was already stored
at the new address, import the original account key explicitly to change accounts.

Tests cover automatic public-account reuse against two TLS servers, rejection of
a different certificate, preservation of an existing destination account, startup
endpoint/key migration, recovery of the original key and isolation from 1.4.4.
