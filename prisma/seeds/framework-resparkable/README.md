# Resparkable seed units

Numbered from `001` **inside this directory**. The seed runner discovers seeds
recursively and `SeedHistory` keys on the path relative to `prisma/seeds/`, so
`framework-resparkable/001-*` cannot collide with a host project's own `001-*`.
Ordering is free too: digit-prefixed core seeds run before letter-prefixed
subdirectories, so Resparkable's seeds land after the host's.

Do **not** renumber these against a host project. See
[`.context/framework/resparkable/README.md`](../../../.context/framework/resparkable/README.md).

First seeds arrive in phase 6 (capabilities, agent profile, agents), then
workflows in phase 7 and MCP exposure plus the triage evaluation dataset in 7b.
